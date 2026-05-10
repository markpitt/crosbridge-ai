import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

import Ajv from 'ajv';
import express from 'express';
import { jsonrepair } from 'jsonrepair';
import { WebSocketServer, WebSocket } from 'ws';

import { buildPrompt, flattenContent } from '../public/lib/prompt-cache.js';
import { BASE_SYSTEM_PROMPT } from '../public/lib/prompt-constants.js';

const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_MODEL = 'chrome-prompt-api';
const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 300000);
const MAX_LOG_ENTRIES = 200;
const MAX_LOCAL_TOOL_REPAIRS = 3;
const MAX_TOOL_REPAIR_GENERATIONS = 3;
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
const markedDir = path.join(__dirname, '..', 'node_modules', 'marked', 'lib');
const MODEL_CREATED_AT = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);

function estimateTokens(text = '') {
  return Math.ceil(text.length / 4);
}

function countWords(text = '') {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function extractDelta(accumulatedText = '', nextText = '') {
  if (!nextText) {
    return '';
  }

  if (nextText.startsWith(accumulatedText)) {
    return nextText.slice(accumulatedText.length);
  }

  return nextText;
}

function openAiError(message, type = 'invalid_request_error', code) {
  return {
    error: {
      message,
      type,
      code: code ?? null,
    },
  };
}

function createHttpError(status, message, type = 'api_error', code, details) {
  const error = new Error(message);
  error.status = status;
  error.type = type;
  error.code = code ?? null;
  error.details = details ?? null;
  return error;
}

function chatChunkPayload({ id, created, model, delta, finishReason, usage }) {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason ?? null,
      },
    ],
  };

  if (usage) {
    payload.usage = usage;
  }

  return payload;
}

function chatCompletionPayload({ id, created, model, text, usage }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
}

function chatToolCompletionPayload({ id, created, model, toolCalls, usage }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls,
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage,
  };
}

function modelPayload(id = DEFAULT_MODEL) {
  return {
    id,
    object: 'model',
    created: MODEL_CREATED_AT,
    owned_by: 'localnanollm',
  };
}

function roundMetric(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function openSse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.filter((tool) => tool?.type === 'function' && typeof tool?.function?.name === 'string');
}

function buildToolDefinitionMap(tools) {
  return new Map(
    normalizeTools(tools).map((tool) => [
      tool.function.name,
      (() => {
        const parameters = tool.function.parameters ?? {};
        let validator = null;
        let validatorError = null;

        if (parameters && typeof parameters === 'object') {
          try {
            validator = ajv.compile(parameters);
          } catch (error) {
            validatorError = error instanceof Error ? error.message : String(error);
          }
        }

        return {
          name: tool.function.name,
          parameters,
          validator,
          validatorError,
        };
      })(),
    ]),
  );
}

function summarizeValidationErrors(errors = []) {
  return errors.map((error) => ({
    instancePath: error.instancePath || '',
    schemaPath: error.schemaPath || '',
    keyword: error.keyword || '',
    message: error.message || '',
    params: error.params || {},
  }));
}

function tryJsonRepair(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  try {
    return jsonrepair(text).trim();
  } catch {
    return null;
  }
}

function escapeInnerQuotesInJsonLikeText(text) {
  if (typeof text !== 'string' || !text.includes('"')) {
    return null;
  }

  const chars = [...text];
  const result = [];
  const stack = [];
  let inString = false;
  let escaping = false;
  let stringRole = 'value';
  let changed = false;

  const nextNonWhitespace = (index) => {
    for (let cursor = index + 1; cursor < chars.length; cursor += 1) {
      if (!/\s/.test(chars[cursor])) {
        return chars[cursor];
      }
    }

    return null;
  };

  const markValueConsumed = () => {
    const top = stack[stack.length - 1];
    if (!top) {
      return;
    }

    top.expecting = 'comma_or_end';
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];

    if (inString) {
      if (escaping) {
        result.push(char);
        escaping = false;
        continue;
      }

      if (char === '\\') {
        result.push(char);
        escaping = true;
        continue;
      }

      if (char === '"') {
        const next = nextNonWhitespace(index);
        const shouldClose =
          stringRole === 'key'
            ? next === ':'
            : next === null || next === ',' || next === '}' || next === ']';

        if (shouldClose) {
          inString = false;
          result.push(char);

          const top = stack[stack.length - 1];
          if (top?.type === 'object') {
            top.expecting = stringRole === 'key' ? 'colon' : 'comma_or_end';
          } else if (top?.type === 'array' && stringRole === 'value') {
            top.expecting = 'comma_or_end';
          }
          continue;
        }

        result.push('\\"');
        changed = true;
        continue;
      }

      result.push(char);
      continue;
    }

    if (char === '"') {
      const top = stack[stack.length - 1];
      stringRole = top?.type === 'object' && top.expecting === 'key' ? 'key' : 'value';
      inString = true;
      result.push(char);
      continue;
    }

    result.push(char);

    if (char === '{') {
      stack.push({ type: 'object', expecting: 'key' });
      continue;
    }

    if (char === '[') {
      stack.push({ type: 'array', expecting: 'value' });
      continue;
    }

    if (char === '}' || char === ']') {
      stack.pop();
      markValueConsumed();
      continue;
    }

    const top = stack[stack.length - 1];
    if (!top) {
      continue;
    }

    if (char === ':') {
      if (top.type === 'object') {
        top.expecting = 'value';
      }
      continue;
    }

    if (char === ',') {
      top.expecting = top.type === 'object' ? 'key' : 'value';
      continue;
    }

    if (!/\s/.test(char) && top.expecting === 'value' && char !== '"' && char !== '{' && char !== '[') {
      markValueConsumed();
    }
  }

  return changed ? result.join('') : null;
}

function describeToolChoice(toolChoice) {
  if (toolChoice === 'required') {
    return 'You must return one or more tool calls.';
  }

  if (toolChoice === 'none') {
    return 'You must not call tools and must return a final answer.';
  }

  if (toolChoice?.type === 'function' && typeof toolChoice?.function?.name === 'string') {
    return `You must call the function named "${toolChoice.function.name}".`;
  }

  return 'Use tools only when they are needed to answer correctly.';
}

function findLastUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index];
    }
  }

  return null;
}

function buildToolPreferenceHints(messages, tools) {
  const lastUserMessage = findLastUserMessage(messages);
  const lastUserContent = flattenContent(lastUserMessage?.content).toLowerCase();
  if (!lastUserContent) {
    return [];
  }

  const toolNames = new Set(tools.map((tool) => tool.function.name));
  const hints = [];
  const fileTaskPattern =
    /\b(file|script|test|tests|python|module|source|code)\b/;
  const createPattern =
    /\b(write|create|add|save|generate|make)\b/;
  const editPattern =
    /\b(edit|modify|update|change|fix|rewrite|patch|append|replace)\b/;
  const shellPattern =
    /\b(run|execute|check|inspect|show|list|print|disk|memory|ram|mount|df|free|ls|cat|python)\b/;

  if (toolNames.has('write') && fileTaskPattern.test(lastUserContent) && createPattern.test(lastUserContent)) {
    hints.push('If you need to create a new file, prefer the "write" tool instead of "shell".');
  }

  if (toolNames.has('edit') && fileTaskPattern.test(lastUserContent) && editPattern.test(lastUserContent)) {
    hints.push('If you need to modify an existing file, prefer the "edit" tool instead of "shell".');
  }

  if (toolNames.has('shell') && shellPattern.test(lastUserContent) && !createPattern.test(lastUserContent)) {
    hints.push('If the user asks you to run or inspect commands, prefer the "shell" tool.');
  }

  return hints;
}

function buildToolInstruction(tools, toolChoice, messages = []) {
  const serializedTools = JSON.stringify(
    tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? '',
      parameters: tool.function.parameters ?? {},
    })),
    null,
    2,
  );

  return [
    'The base system prompt already defines the OpenAI-compatible response format and the default tool-call JSON shapes.',
    'If the conversation already includes tool results that answer the user, return a final answer instead of repeating the same tool call.',
    describeToolChoice(toolChoice),
    ...buildToolPreferenceHints(messages, tools),
    'Available tools:',
    serializedTools,
  ].join('\n');
}

function prepareMessagesForModel(messages, tools, toolChoice) {
  if (!tools.length || toolChoice === 'none') {
    return messages;
  }

  return [
    {
      role: 'system',
      content: buildToolInstruction(tools, toolChoice, messages),
    },
    ...messages,
  ];
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function parseJsonValue(text) {
  const candidate = stripCodeFence(text);

  try {
    return JSON.parse(candidate);
  } catch {
    const escaped = escapeInnerQuotesInJsonLikeText(candidate);
    if (escaped && escaped !== candidate) {
      try {
        return JSON.parse(escaped);
      } catch {
        // Fall through to jsonrepair.
      }
    }

    const repaired = tryJsonRepair(candidate);
    if (repaired && repaired !== candidate) {
      try {
        return JSON.parse(repaired);
      } catch {
        // Fall through to slice extraction.
      }
    }

    const starts = ['{', '[']
      .map((symbol) => candidate.indexOf(symbol))
      .filter((index) => index !== -1)
      .sort((left, right) => left - right);
    const firstIndex = starts[0];
    const lastBrace = candidate.lastIndexOf('}');
    const lastBracket = candidate.lastIndexOf(']');
    const lastIndex = Math.max(lastBrace, lastBracket);

    if (firstIndex === undefined || lastIndex === -1 || lastIndex <= firstIndex) {
      return null;
    }

    try {
      return JSON.parse(candidate.slice(firstIndex, lastIndex + 1));
    } catch {
      const escapedSlice = escapeInnerQuotesInJsonLikeText(candidate.slice(firstIndex, lastIndex + 1));
      if (escapedSlice) {
        try {
          return JSON.parse(escapedSlice);
        } catch {
          // Fall through to jsonrepair.
        }
      }

      const repairedSlice = tryJsonRepair(candidate.slice(firstIndex, lastIndex + 1));
      if (repairedSlice) {
        try {
          return JSON.parse(repairedSlice);
        } catch {
          return null;
        }
      }

      return null;
    }
  }
}

function extractLikelyJsonSlice(text) {
  const candidate = stripCodeFence(text);
  const starts = ['{', '[']
    .map((symbol) => candidate.indexOf(symbol))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right);
  const firstIndex = starts[0];
  const lastBrace = candidate.lastIndexOf('}');
  const lastBracket = candidate.lastIndexOf(']');
  const lastIndex = Math.max(lastBrace, lastBracket);

  if (firstIndex === undefined || lastIndex === -1 || lastIndex <= firstIndex) {
    return null;
  }

  return candidate.slice(firstIndex, lastIndex + 1).trim();
}

function unescapeLikelyJsonString(text) {
  const candidate = stripCodeFence(text).trim();
  if (!candidate || (!candidate.includes('\\"') && !candidate.includes('\\n') && !candidate.includes('\\\\'))) {
    return null;
  }

  const unescaped = candidate
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\')
    .trim();

  if (!unescaped || unescaped === candidate) {
    return null;
  }

  return unescaped;
}

function collectToolRepairCandidates(text) {
  const candidates = [];
  const seen = new Set([text]);
  const addCandidate = (label, candidate) => {
    if (typeof candidate !== 'string') {
      return;
    }

    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }

    seen.add(trimmed);
    candidates.push({ label, text: trimmed });
  };

  const stripped = stripCodeFence(text).trim();
  addCandidate('strip-code-fence', stripped);

  const parsed = parseJsonValue(text);
  if (typeof parsed === 'string') {
    addCandidate('parse-stringified-json', parsed);
    addCandidate('extract-json-from-stringified', extractLikelyJsonSlice(parsed));
  }

  addCandidate('escape-inner-quotes', escapeInnerQuotesInJsonLikeText(stripped));
  addCandidate('jsonrepair', tryJsonRepair(stripped));
  addCandidate('extract-json-slice', extractLikelyJsonSlice(text));
  addCandidate('unescape-json-string', unescapeLikelyJsonString(text));

  return candidates.slice(0, MAX_LOCAL_TOOL_REPAIRS);
}

function normalizeToolArguments(rawArguments) {
  if (typeof rawArguments === 'string') {
    return rawArguments;
  }

  return JSON.stringify(rawArguments ?? {});
}

function inferSingleStringArgumentName(parameters) {
  if (parameters?.type !== 'object' || !parameters?.properties || typeof parameters.properties !== 'object') {
    return null;
  }

  const propertyEntries = Object.entries(parameters.properties).filter(
    ([, definition]) => definition && typeof definition === 'object',
  );
  if (propertyEntries.length !== 1) {
    return null;
  }

  const [[propertyName, definition]] = propertyEntries;
  return definition.type === 'string' ? propertyName : null;
}

function stripWrappingQuotes(text) {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function coerceToolArguments(rawArguments, toolDefinition) {
  if (typeof rawArguments !== 'string') {
    return JSON.stringify(rawArguments ?? {});
  }

  const trimmed = rawArguments.trim();
  if (!trimmed) {
    return '{}';
  }

  const parsed = parseJsonValue(trimmed);
  if (parsed !== null) {
    if (typeof parsed === 'string') {
      const singleArgName = inferSingleStringArgumentName(toolDefinition?.parameters);
      if (singleArgName) {
        return JSON.stringify({ [singleArgName]: parsed });
      }
    }

    return JSON.stringify(parsed);
  }

  const repaired = tryJsonRepair(trimmed);
  if (repaired) {
    const repairedParsed = parseJsonValue(repaired);
    if (repairedParsed !== null) {
      if (typeof repairedParsed === 'string') {
        const singleArgName = inferSingleStringArgumentName(toolDefinition?.parameters);
        if (singleArgName) {
          return JSON.stringify({ [singleArgName]: repairedParsed });
        }
      }

      return JSON.stringify(repairedParsed);
    }
  }

  const singleArgName = inferSingleStringArgumentName(toolDefinition?.parameters);
  if (singleArgName) {
    const propertyPrefixPattern = new RegExp(`^["']?${singleArgName}["']?\\s*:\\s*`, 'i');
    const valueText = propertyPrefixPattern.test(trimmed) ? trimmed.replace(propertyPrefixPattern, '') : trimmed;
    return JSON.stringify({ [singleArgName]: stripWrappingQuotes(valueText) });
  }

  return JSON.stringify(trimmed);
}

function canonicalizeToolName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveAllowedToolName(name, allowedNames) {
  if (allowedNames.has(name)) {
    return name;
  }

  const canonicalName = canonicalizeToolName(name);
  const candidates = Array.from(allowedNames).filter((allowedName) => canonicalizeToolName(allowedName) === canonicalName);
  if (candidates.length === 1) {
    return candidates[0];
  }

  const looseCandidates = Array.from(allowedNames).filter((allowedName) => {
    const canonicalAllowedName = canonicalizeToolName(allowedName);
    return canonicalAllowedName.endsWith(canonicalName) || canonicalName.endsWith(canonicalAllowedName);
  });
  if (looseCandidates.length === 1) {
    return looseCandidates[0];
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function normalizeToolCall(toolCall, allowedNames, toolDefinitions, index) {
  const rawName =
    toolCall?.name ??
    toolCall?.function?.name ??
    (typeof toolCall?.type === 'string' && toolCall.type !== 'function' ? toolCall.type : null);
  if (typeof rawName !== 'string') {
    return {
      value: null,
      error: {
        reason: 'missing_tool_name',
        rawToolName: null,
      },
    };
  }

  const name = resolveAllowedToolName(rawName, allowedNames);
  if (!name) {
    return {
      value: null,
      error: {
        reason: 'unknown_tool_name',
        rawToolName: rawName,
      },
    };
  }

  const toolDefinition = toolDefinitions.get(name);
  if (toolDefinition?.validatorError) {
    return {
      value: null,
      error: {
        reason: 'invalid_tool_schema',
        rawToolName: rawName,
        normalizedToolName: name,
        validatorError: toolDefinition.validatorError,
      },
    };
  }

  const argumentsText = coerceToolArguments(toolCall?.arguments ?? toolCall?.function?.arguments ?? {}, toolDefinition);
  const parsedArguments = parseJsonValue(argumentsText);
  if (parsedArguments === null || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
    return {
      value: null,
      error: {
        reason: 'invalid_tool_arguments_json',
        rawToolName: rawName,
        normalizedToolName: name,
        argumentsPreview: String(argumentsText).slice(0, 200),
      },
    };
  }

  if (typeof toolDefinition?.validator === 'function' && !toolDefinition.validator(parsedArguments)) {
    return {
      value: null,
      error: {
        reason: 'tool_arguments_failed_schema_validation',
        rawToolName: rawName,
        normalizedToolName: name,
        argumentsPreview: JSON.stringify(parsedArguments).slice(0, 200),
        validationErrors: summarizeValidationErrors(toolDefinition.validator.errors),
      },
    };
  }

  return {
    value: {
      id: typeof toolCall?.id === 'string' ? toolCall.id : `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(parsedArguments),
      },
      index,
    },
    error: null,
  };
}

function looksLikeToolCallResponse(text, parsed) {
  if (typeof parsed === 'string') {
    const nestedParsed = parseJsonValue(parsed);
    const nestedCandidate = stripCodeFence(parsed);
    if (nestedParsed !== null && nestedParsed !== parsed) {
      return looksLikeToolCallResponse(parsed, nestedParsed);
    }

    return /"tool_calls"\s*:|^\s*\[\s*\{[\s\S]*"arguments"\s*:|^\s*\{\s*"type"\s*:\s*"(?!final")/i.test(nestedCandidate);
  }

  if (Array.isArray(parsed) || Array.isArray(parsed?.tool_calls) || Array.isArray(parsed?.calls) || parsed?.type === 'tool_calls') {
    return true;
  }

  const candidate = stripCodeFence(text);
  return /"tool_calls"\s*:|```tool_calls```|^\s*\[\s*\{[\s\S]*"arguments"\s*:|^\s*\{\s*"type"\s*:\s*"(?!final")/i.test(candidate);
}

function buildMalformedToolCallDetails(text, allowedNames, rawToolCalls, normalizationErrors = []) {
  return {
    allowedToolNames: Array.from(allowedNames),
    rawToolNames: Array.isArray(rawToolCalls)
      ? rawToolCalls.map((toolCall) => toolCall?.name ?? toolCall?.function?.name ?? toolCall?.type ?? null)
      : [],
    responsePreview: stripCodeFence(text).slice(0, 400),
    normalizationErrors,
  };
}

function normalizeSingleToolModeResponse(text, tools) {
  const parsed = parseJsonValue(text);
  const allowedNames = new Set(tools.map((tool) => tool.function.name));
  const toolDefinitions = buildToolDefinitionMap(tools);

  let rawToolCalls = null;

  if (Array.isArray(parsed)) {
    rawToolCalls = parsed;
  } else if (Array.isArray(parsed?.tool_calls)) {
    rawToolCalls = parsed.tool_calls;
  } else if (parsed?.type === 'tool_calls' && Array.isArray(parsed?.calls)) {
    rawToolCalls = parsed.calls;
  } else if (typeof parsed?.type === 'string' && resolveAllowedToolName(parsed.type, allowedNames)) {
    rawToolCalls = [
      {
        name: parsed.type,
        arguments: parsed.arguments ?? parsed.parameters ?? {},
      },
    ];
  }

  if (rawToolCalls) {
    const normalizedResults = rawToolCalls.map((toolCall, index) =>
      normalizeToolCall(toolCall, allowedNames, toolDefinitions, index),
    );
    const toolCalls = normalizedResults.map((result) => result.value).filter(Boolean);
    const normalizationErrors = normalizedResults.map((result) => result.error).filter(Boolean);

    if (toolCalls.length > 0) {
      return {
        kind: 'tool_calls',
        toolCalls,
        malformedToolCall: null,
      };
    }

    return {
      kind: 'final',
      content: text,
      malformedToolCall: buildMalformedToolCallDetails(text, allowedNames, rawToolCalls, normalizationErrors),
    };
  }

  if (parsed?.type === 'final' && typeof parsed?.content === 'string') {
    return {
      kind: 'final',
      content: parsed.content,
    };
  }

  const looseFinalMatch = stripCodeFence(text).match(/["']type["']\s*:\s*["']final["'][\s\S]*?["']content["']\s*:\s*"([\s\S]*)"\s*\}?$/);
  if (looseFinalMatch) {
    return {
      kind: 'final',
      content: looseFinalMatch[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\'),
    };
  }

  return {
    kind: 'final',
    content: text,
    malformedToolCall: looksLikeToolCallResponse(text, parsed) ? buildMalformedToolCallDetails(text, allowedNames, null) : null,
  };
}

function normalizeToolModeResponse(text, tools) {
  const originalResult = normalizeSingleToolModeResponse(text, tools);
  originalResult.localRepairCount = 0;
  originalResult.repairedBy = null;
  originalResult.localRepairAttempts = [];

  if (originalResult.kind === 'tool_calls' || !originalResult.malformedToolCall) {
    return originalResult;
  }

  let fallbackResult = originalResult;
  const localRepairAttempts = [];
  for (const [index, candidate] of collectToolRepairCandidates(text).entries()) {
    const repairedResult = normalizeSingleToolModeResponse(candidate.text, tools);
    repairedResult.localRepairCount = index + 1;
    repairedResult.repairedBy = candidate.label;
    const attempt = {
      repair: candidate.label,
      index: index + 1,
      outcome:
        repairedResult.kind === 'tool_calls'
          ? 'tool_calls'
          : repairedResult.malformedToolCall
            ? 'still_malformed'
            : 'not_tool_shaped',
      responsePreview: stripCodeFence(candidate.text).slice(0, 200),
      rawToolNames: repairedResult.malformedToolCall?.rawToolNames ?? [],
    };
    localRepairAttempts.push(attempt);
    repairedResult.localRepairAttempts = [...localRepairAttempts];

    if (repairedResult.kind === 'tool_calls') {
      return repairedResult;
    }

    fallbackResult = repairedResult.malformedToolCall
      ? repairedResult
      : {
          ...fallbackResult,
          localRepairAttempts: [...localRepairAttempts],
        };
  }

  return fallbackResult;
}

function shouldRetryMalformedToolResponse(toolResponse, toolChoice) {
  return Boolean(
    toolResponse.kind !== 'tool_calls' &&
      (toolResponse.malformedToolCall ||
        toolChoice === 'required' ||
        (toolChoice?.type === 'function' && typeof toolChoice?.function?.name === 'string')),
  );
}

function buildMalformedToolRetryInstruction(tools, toolChoice, messages, toolResponse) {
  const exactToolNames = tools.map((tool) => tool.function.name).join(', ');
  const malformedToolCall = toolResponse?.malformedToolCall ?? null;
  const lastRepairAttempt =
    Array.isArray(toolResponse?.localRepairAttempts) && toolResponse.localRepairAttempts.length > 0
      ? toolResponse.localRepairAttempts[toolResponse.localRepairAttempts.length - 1]
      : null;
  const normalizationErrors = malformedToolCall?.normalizationErrors ?? [];

  return [
    'Your previous response looked like an attempted tool call, but it could not be parsed or matched to the available tools.',
    `Use one of these exact tool names: ${exactToolNames}.`,
    'Return raw JSON only with no markdown fences and no explanation.',
    'For one tool call, output exactly {"type":"tool_name","arguments":{}}.',
    'For multiple tool calls, output exactly {"type":"tool_calls","tool_calls":[{"name":"tool_name","arguments":{}}]}.',
    'Valid example: {"type":"tool_calls","tool_calls":[{"name":"tool_name","arguments":{"key":"value"}}]}.',
    'If a tool argument contains quotes inside a string, escape them correctly.',
    describeToolChoice(toolChoice),
    ...buildToolPreferenceHints(messages, tools),
    ...(malformedToolCall?.rawToolNames?.length ? [`Previous tool names: ${malformedToolCall.rawToolNames.join(', ')}`] : []),
    ...(normalizationErrors.length ? [`Validation/parsing failures: ${JSON.stringify(normalizationErrors)}`] : []),
    ...(lastRepairAttempt ? [`Bridge repair candidate: ${lastRepairAttempt.responsePreview}`] : []),
  ].join('\n');
}

function toolCallName(toolCall) {
  return toolCall?.function?.name ?? toolCall?.name ?? null;
}

function toolCallArguments(toolCall) {
  return toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
}

function createToolCallSignature(toolCall) {
  const name = toolCallName(toolCall);
  if (typeof name !== 'string') {
    return null;
  }

  return `${canonicalizeToolName(name)}:${normalizeToolArguments(toolCallArguments(toolCall))}`;
}

function collectExecutedToolSignatures(messages) {
  const toolMessageIds = new Set(
    messages
      .filter((message) => message?.role === 'tool' && typeof message?.tool_call_id === 'string')
      .map((message) => message.tool_call_id),
  );

  return new Set(
    messages.flatMap((message) => {
      if (message?.role !== 'assistant' || !Array.isArray(message?.tool_calls)) {
        return [];
      }

      return message.tool_calls
        .filter((toolCall) => {
          const toolName = toolCallName(toolCall);
          const hasNamedToolResult =
            typeof toolName === 'string' &&
            messages.some((toolMessage) => toolMessage?.role === 'tool' && toolMessage?.name === toolName);

          return (typeof toolCall?.id === 'string' && toolMessageIds.has(toolCall.id)) || hasNamedToolResult;
        })
        .map((toolCall) => createToolCallSignature(toolCall))
        .filter(Boolean);
    }),
  );
}

function isDuplicateToolResponse(messages, toolCalls) {
  const executedToolSignatures = collectExecutedToolSignatures(messages);

  return (
    toolCalls.length > 0 &&
    toolCalls.every((toolCall) => {
      const signature = createToolCallSignature(toolCall);
      return signature ? executedToolSignatures.has(signature) : false;
    })
  );
}

function buildDuplicateToolRetryInstruction(toolCalls) {
  const toolList = toolCalls
    .map((toolCall) => {
      const name = toolCallName(toolCall) || 'tool';
      return `${name}(${normalizeToolArguments(toolCallArguments(toolCall))})`;
    })
    .join(', ');

  return [
    'You already have the results for these tool calls:',
    toolList,
    'Do not call the same tool again.',
    'Use the existing tool results in the conversation and answer the user directly.',
    'Return a normal final answer, not JSON.',
  ].join('\n');
}

function safeJsonSend(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function parseCliArgs(argv) {
  const options = {
    openBrowser: true,
    port: DEFAULT_PORT,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--no-open') {
      options.openBrowser = false;
      continue;
    }

    if (arg === '--port') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('Expected a non-negative integer after --port.');
      }
      options.port = value;
      index += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('Expected a positive integer after --timeout-ms.');
      }
      options.requestTimeoutMs = value;
      index += 1;
    }
  }

  return options;
}

function tryOpenBrowser(url) {
  const child = spawn('xdg-open', [url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function serializeChatSession(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages,
  };
}

export function createBridgeServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/bridge' });
  const config = {
    openBrowser: options.openBrowser ?? false,
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };

  const state = {
    browser: null,
    browserInfo: null,
    bridgeToken: randomUUID(),
    logs: [],
    jobs: new Map(),
    sessions: new Map(),
    stats: {
      requests: 0,
      completed: 0,
      failed: 0,
      active: 0,
      totalInputChars: 0,
      totalOutputChars: 0,
      totalInputWords: 0,
      totalOutputWords: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    },
  };

  function getStatusPayload() {
    return {
      browserConnected: Boolean(state.browser),
      browserInfo: state.browserInfo,
      stats: state.stats,
      logs: state.logs.slice(-25),
    };
  }

  function addLog(level, message, details) {
    const entry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      level,
      message,
      details: details ?? null,
    };

    const detailSuffix = entry.details ? ` ${JSON.stringify(entry.details)}` : '';
    const line = `[${entry.ts}] ${entry.level.toUpperCase()} ${entry.message}${detailSuffix}`;

    if (entry.level === 'error') {
      console.error(line);
    } else if (entry.level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }

    state.logs.push(entry);
    if (state.logs.length > MAX_LOG_ENTRIES) {
      state.logs.shift();
    }

    safeJsonSend(state.browser, { type: 'server-log', entry });
    safeJsonSend(state.browser, {
      type: 'server-state',
      ...getStatusPayload(),
    });
  }

  function sendBrowserState() {
    safeJsonSend(state.browser, {
      type: 'server-state',
      ...getStatusPayload(),
    });
  }

  function buildUsage(promptText, completionText, browserUsage = {}) {
    const promptTokens = Number.isFinite(browserUsage.prompt_tokens)
      ? browserUsage.prompt_tokens
      : estimateTokens(promptText);
    const completionTokens = Number.isFinite(browserUsage.completion_tokens)
      ? browserUsage.completion_tokens
      : estimateTokens(completionText);

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }

  function buildRequestMetrics(job, usage, extra = {}) {
    const totalMs = Number.isFinite(job.timings?.total_ms) ? job.timings.total_ms : null;
    const ttftMs = Number.isFinite(job.timings?.ttft_ms) ? job.timings.ttft_ms : null;
    const outputChars = Number.isFinite(extra.outputChars) ? extra.outputChars : job.outputText.length;
    const completionTokensPerSecond =
      totalMs && totalMs > 0 ? roundMetric((usage.completion_tokens * 1000) / totalMs) : null;

    return {
      source: job.metadata?.source ?? 'bridge',
      stream: Boolean(job.metadata?.stream),
      messageCount: job.metadata?.messageCount ?? null,
      toolsProvided: job.metadata?.toolsProvided ?? 0,
      cacheEnabled: Boolean(job.metadata?.cacheEnabled),
      toolCallsReturned: job.metadata?.toolCallsReturned ?? 0,
      duplicateRetry: Boolean(job.metadata?.duplicateRetry),
      finishReason: job.metadata?.finishReason ?? 'stop',
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      inputChars: job.promptText.length,
      outputChars,
      chunkCount: job.chunkCount ?? 0,
      totalMs,
      ttftMs,
      tokensPerSecond: completionTokensPerSecond,
      contextWindow: Number.isFinite(job.browserUsage?.context_window) ? job.browserUsage.context_window : null,
      trimmedMessages: Number.isFinite(job.browserUsage?.trimmed_messages) ? job.browserUsage.trimmed_messages : 0,
      streamFallbackUsed: Boolean(job.browserUsage?.stream_fallback_used),
      cacheHit: Boolean(job.browserUsage?.cache_hit),
      cachePrefixMessages: Number.isFinite(job.browserUsage?.cache_prefix_messages)
        ? job.browserUsage.cache_prefix_messages
        : 0,
      cacheSuffixMessages: Number.isFinite(job.browserUsage?.cache_suffix_messages)
        ? job.browserUsage.cache_suffix_messages
        : 0,
      cacheEntries: Number.isFinite(job.browserUsage?.cache_entries) ? job.browserUsage.cache_entries : 0,
      cacheStored: Boolean(job.browserUsage?.cache_stored),
      cacheAwaitingStore: Boolean(job.browserUsage?.cache_awaiting_store),
      ...extra,
    };
  }

  function cleanupJob(job) {
    clearTimeout(job.timeout);
    state.jobs.delete(job.id);
    state.stats.active = Math.max(0, state.stats.active - 1);
    sendBrowserState();
  }

  function armJobTimeout(job) {
    clearTimeout(job.timeout);
    job.timeout = setTimeout(() => {
      rejectJob(job, 504, 'The browser bridge timed out while generating a response.', 'timeout_error', 'timeout_error');
    }, config.requestTimeoutMs);
  }

  function resolveJob(job, completionText, browserUsage, timings) {
    if (!job || job.finished) {
      return;
    }

    if (browserUsage) {
      job.browserUsage = {
        ...job.browserUsage,
        ...browserUsage,
      };
    }
    if (timings) {
      job.timings = {
        ...job.timings,
        ...timings,
      };
    }

    const usage = buildUsage(job.promptText, completionText, browserUsage);
    const outputWords = countWords(completionText);
    const outputChars = completionText.length;

    state.stats.completed += 1;
    state.stats.totalOutputChars += outputChars;
    state.stats.totalOutputWords += outputWords;
    state.stats.totalOutputTokens += usage.completion_tokens;

    job.finished = true;
    addLog(
      'info',
      `Request completed: ${job.id}`,
        buildRequestMetrics(job, usage, {
          outputWords,
          outputChars,
        }),
      );

    job.resolve({ text: completionText, usage });
    cleanupJob(job);
  }

  function rejectJob(job, statusCode, message, type = 'api_error', code = null, details = null) {

    if (!job || job.finished) {
      return;
    }

    job.finished = true;
    state.stats.failed += 1;
    addLog('error', `Request failed: ${job.id}`, { message, type, code, ...details });
    job.reject(createHttpError(statusCode, message, type, code, details));
    cleanupJob(job);
  }

  function createChatSession() {
    const now = new Date().toISOString();
    const session = {
      id: `session-${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    state.sessions.set(session.id, session);
    return session;
  }

  function requireBrowserReady() {
    if (!state.browser) {
      throw createHttpError(
        503,
        'No browser bridge is connected. Open the hosted page in Chrome first.',
        'bridge_unavailable',
      );
    }

    if (!state.browserInfo?.promptApiAvailable) {
      throw createHttpError(
        503,
        'The connected browser does not expose the Prompt API.',
        'prompt_api_unavailable',
      );
    }
  }

  function canUsePromptCache(messages, toolsProvided = 0) {
    return Array.isArray(messages) && messages.length > 0;
  }

  function sendCacheStore(requestId, messages) {
    safeJsonSend(state.browser, {
      type: 'cache-store',
      requestId,
      messages,
    });
  }

  function sendCacheDiscard(requestId) {
    safeJsonSend(state.browser, {
      type: 'cache-discard',
      requestId,
    });
  }

  function isAllowedBridgeRequest(req) {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (requestUrl.searchParams.get('token') !== state.bridgeToken) {
      return false;
    }

    const origin = req.headers.origin;
    if (!origin) {
      return true;
    }

    try {
      const originUrl = new URL(origin);
      const expectedOrigin = new URL(`http://${req.headers.host || config.host}`).origin;
      return originUrl.origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  function dispatchGeneration({ messages, model = DEFAULT_MODEL, onChunk, metadata }) {
    requireBrowserReady();

    const promptText = buildPrompt(messages);
    const promptWords = countWords(promptText);
    const inputTokens = estimateTokens(promptText);
    const requestId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    state.stats.requests += 1;
    state.stats.active += 1;
    state.stats.totalInputChars += promptText.length;
    state.stats.totalInputWords += promptWords;
    state.stats.totalInputTokens += inputTokens;

    addLog('info', `Accepted request: ${requestId}`, {
      source: metadata?.source ?? 'bridge',
      stream: Boolean(metadata?.stream),
      messageCount: metadata?.messageCount ?? messages.length,
      toolsProvided: metadata?.toolsProvided ?? 0,
      inputChars: promptText.length,
      inputWords: promptWords,
      inputTokens,
      cacheEnabled: Boolean(metadata?.cacheEnabled),
    });

    let resolve;
    let reject;
    const result = new Promise((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });

    const job = {
      id: requestId,
      created,
      model,
      promptText,
      outputText: '',
      onChunk,
      metadata: {
        source: metadata?.source ?? 'bridge',
        stream: Boolean(metadata?.stream),
        messageCount: metadata?.messageCount ?? messages.length,
        toolsProvided: metadata?.toolsProvided ?? 0,
        cacheEnabled: Boolean(metadata?.cacheEnabled),
        toolCallsReturned: 0,
        duplicateRetry: false,
        finishReason: 'stop',
      },
      browserUsage: null,
      timings: null,
      chunkCount: 0,
      finished: false,
      resolve,
      reject,
      result,
      timeout: null,
    };

    armJobTimeout(job);
    state.jobs.set(requestId, job);
    sendBrowserState();

    safeJsonSend(state.browser, {
      type: 'generate',
      requestId,
      payload: {
        model,
        messages,
        promptText,
        cache: {
          enabled: metadata?.cacheEnabled === true,
          minPrefixMessages: metadata?.minCachePrefixMessages ?? 2,
          awaitServerStore: metadata?.awaitServerStore === true,
        },
      },
    });

    return job;
  }

  async function handleOpenAiCompletion(req, res) {
    const {
      messages,
      stream = false,
      model = DEFAULT_MODEL,
      stream_options: streamOptions,
      tools: requestedTools,
      tool_choice: toolChoice = 'auto',
    } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json(openAiError('The request body must include a non-empty messages array.'));
      return;
    }

    if (model !== DEFAULT_MODEL) {
      res.status(404).json(openAiError(`The model "${model}" does not exist.`, 'invalid_request_error'));
      return;
    }

    const tools = normalizeTools(requestedTools);
    const toolMode = tools.length > 0 && toolChoice !== 'none';
    const effectiveMessages = prepareMessagesForModel(messages, tools, toolChoice);
    let job;

    try {
        job = dispatchGeneration({
          messages: effectiveMessages,
          model,
          metadata: {
            source: 'openai-chat',
            stream,
            messageCount: messages.length,
            toolsProvided: tools.length,
            cacheEnabled: canUsePromptCache(effectiveMessages, tools.length),
            awaitServerStore: toolMode,
          },
        onChunk: ({ delta }) => {
          if (!stream || toolMode || res.writableEnded) {
            return;
          }

          writeSse(
            res,
            chatChunkPayload({
              id: job.id,
              created: job.created,
              model: job.model,
              delta: { content: delta },
            }),
          );
        },
      });

      if (stream) {
        openSse(res);

        writeSse(
          res,
          chatChunkPayload({
            id: job.id,
            created: job.created,
            model: job.model,
            delta: { role: 'assistant' },
          }),
        );
      }

      const { text, usage } = await job.result;

      if (toolMode) {
        let toolResponse = normalizeToolModeResponse(text, tools);
        let responseJob = job;
        let responseUsage = usage;
        let malformedRepairGenerationCount = 0;

        if (toolResponse.kind === 'tool_calls' && toolResponse.localRepairCount > 0) {
          addLog('info', `Recovered tool response locally for ${job.id}`, {
            repair: toolResponse.repairedBy,
            localRepairCount: toolResponse.localRepairCount,
            localRepairAttempts: toolResponse.localRepairAttempts,
          });
        }

        if (toolResponse.malformedToolCall) {
          addLog('warn', `Could not normalize tool calls for ${job.id}`, {
            ...toolResponse.malformedToolCall,
            localRepairAttempts: toolResponse.localRepairAttempts,
          });
        }

        while (
          malformedRepairGenerationCount < MAX_TOOL_REPAIR_GENERATIONS &&
          shouldRetryMalformedToolResponse(toolResponse, toolChoice)
        ) {
          malformedRepairGenerationCount += 1;
          addLog('warn', `Retrying malformed tool response for ${responseJob.id}`, {
            ...(toolResponse.malformedToolCall ?? {}),
            attempt: malformedRepairGenerationCount,
            maxAttempts: MAX_TOOL_REPAIR_GENERATIONS,
          });
          if (responseJob.metadata.cacheEnabled) {
            sendCacheDiscard(responseJob.id);
          }

          const retryJob = dispatchGeneration({
            messages: [
              {
                role: 'system',
                content: buildToolInstruction(tools, toolChoice, messages),
              },
              {
                role: 'system',
                content: buildMalformedToolRetryInstruction(tools, toolChoice, messages, toolResponse),
              },
              ...messages,
            ],
            model,
              metadata: {
                source: 'openai-chat',
                stream,
                messageCount: messages.length + 2,
                toolsProvided: tools.length,
                cacheEnabled: false,
                awaitServerStore: false,
              },
          });

          const retryResult = await retryJob.result;
          const repairedResponse = normalizeToolModeResponse(retryResult.text, tools);
          if (repairedResponse.kind === 'tool_calls' && repairedResponse.localRepairCount > 0) {
            addLog('info', `Recovered tool response locally for ${retryJob.id}`, {
              repair: repairedResponse.repairedBy,
              localRepairCount: repairedResponse.localRepairCount,
              afterGenerationRetry: malformedRepairGenerationCount,
              localRepairAttempts: repairedResponse.localRepairAttempts,
            });
          }

          if (repairedResponse.malformedToolCall) {
            addLog('warn', `Tool response remained malformed after retry for ${retryJob.id}`, {
              ...repairedResponse.malformedToolCall,
              attempt: malformedRepairGenerationCount,
              maxAttempts: MAX_TOOL_REPAIR_GENERATIONS,
              localRepairAttempts: repairedResponse.localRepairAttempts,
            });
          }

          toolResponse = repairedResponse;
          responseJob = retryJob;
          responseUsage = retryResult.usage;
        }

        if (toolResponse.kind !== 'tool_calls' && shouldRetryMalformedToolResponse(toolResponse, toolChoice)) {
          addLog('error', `Giving up on malformed tool response for ${responseJob.id}`, {
            ...(toolResponse.malformedToolCall ?? {
              responsePreview: stripCodeFence(toolResponse.content ?? '').slice(0, 400),
            }),
            attemptsUsed: malformedRepairGenerationCount,
            maxAttempts: MAX_TOOL_REPAIR_GENERATIONS,
            localRepairAttempts: toolResponse.localRepairAttempts ?? [],
          });
        }

        if (toolResponse.kind === 'tool_calls') {
          if (isDuplicateToolResponse(messages, toolResponse.toolCalls)) {
            responseJob.metadata.duplicateRetry = true;
            addLog('warn', `Retrying duplicate tool calls for ${responseJob.id}`, {
              toolCalls: toolResponse.toolCalls.map((toolCall) => ({
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              })),
            });
            if (responseJob.metadata.cacheEnabled) {
              sendCacheDiscard(responseJob.id);
            }

            const retryJob = dispatchGeneration({
              messages: [
                {
                  role: 'system',
                  content: buildDuplicateToolRetryInstruction(toolResponse.toolCalls),
                },
                ...messages,
              ],
              model,
              metadata: {
                source: 'openai-chat',
                stream,
                messageCount: messages.length + 1,
                toolsProvided: 0,
                cacheEnabled: false,
                awaitServerStore: false,
              },
              onChunk: ({ delta }) => {
                if (!stream || res.writableEnded) {
                  return;
                }

                writeSse(
                  res,
                  chatChunkPayload({
                    id: retryJob.id,
                    created: retryJob.created,
                    model: retryJob.model,
                    delta: { content: delta },
                  }),
                );
              },
            });

            const retryResult = await retryJob.result;
            const finalRetryResponse = normalizeToolModeResponse(retryResult.text, []);
            const retryTrailingContent = stream ? extractDelta(retryJob.outputText, finalRetryResponse.content) : '';
            retryJob.metadata.finishReason = 'stop';

              if (stream) {
                if (retryTrailingContent) {
                  writeSse(
                    res,
                    chatChunkPayload({
                    id: retryJob.id,
                    created: retryJob.created,
                    model: retryJob.model,
                    delta: { content: retryTrailingContent },
                    }),
                  );
                }
                writeSse(
                  res,
                chatChunkPayload({
                  id: retryJob.id,
                  created: retryJob.created,
                  model: retryJob.model,
                  delta: {},
                  finishReason: 'stop',
                    usage: streamOptions?.include_usage ? retryResult.usage : undefined,
                  }),
                );
                res.write('data: [DONE]\n\n');
                res.end();
                if (retryJob.metadata.cacheEnabled) {
                  sendCacheStore(retryJob.id, [...effectiveMessages, { role: 'assistant', content: finalRetryResponse.content }]);
                }
                return;
              }

              res.json(
                chatCompletionPayload({
                id: retryJob.id,
                created: retryJob.created,
                model: retryJob.model,
                text: finalRetryResponse.content,
                usage: retryResult.usage,
                }),
              );
              if (retryJob.metadata.cacheEnabled) {
                sendCacheStore(retryJob.id, [...effectiveMessages, { role: 'assistant', content: finalRetryResponse.content }]);
              }
              return;
            }

          responseJob.metadata.toolCallsReturned = toolResponse.toolCalls.length;
          responseJob.metadata.finishReason = 'tool_calls';
          const toolCalls = toolResponse.toolCalls.map(({ index, ...toolCall }) => toolCall);

          if (stream) {
            for (const toolCall of toolResponse.toolCalls) {
              writeSse(
                res,
                chatChunkPayload({
                  id: responseJob.id,
                  created: responseJob.created,
                  model: responseJob.model,
                  delta: {
                    tool_calls: [
                      {
                        index: toolCall.index,
                        id: toolCall.id,
                        type: toolCall.type,
                        function: toolCall.function,
                      },
                    ],
                  },
                }),
              );
            }

            writeSse(
              res,
              chatChunkPayload({
                id: responseJob.id,
                created: responseJob.created,
                model: responseJob.model,
                delta: {},
                finishReason: 'tool_calls',
                usage: streamOptions?.include_usage ? responseUsage : undefined,
              }),
            );
            res.write('data: [DONE]\n\n');
            res.end();
            if (responseJob.metadata.cacheEnabled) {
              sendCacheStore(responseJob.id, [...effectiveMessages, { role: 'assistant', tool_calls: toolCalls }]);
            }
            return;
          }

          res.json(
            chatToolCompletionPayload({
              id: responseJob.id,
              created: responseJob.created,
              model: responseJob.model,
              toolCalls,
              usage: responseUsage,
            }),
          );
          if (responseJob.metadata.cacheEnabled) {
            sendCacheStore(responseJob.id, [...effectiveMessages, { role: 'assistant', tool_calls: toolCalls }]);
          }
          return;
        }

        responseJob.metadata.finishReason = 'stop';
        if (stream) {
          const trailingContent = extractDelta(responseJob.outputText, toolResponse.content);
          const contentDelta = trailingContent || toolResponse.content;
          if (contentDelta) {
            writeSse(
              res,
              chatChunkPayload({
                id: responseJob.id,
                created: responseJob.created,
                model: responseJob.model,
                delta: { content: contentDelta },
              }),
            );
          }
          writeSse(
            res,
            chatChunkPayload({
              id: responseJob.id,
              created: responseJob.created,
              model: responseJob.model,
              delta: {},
              finishReason: 'stop',
              usage: streamOptions?.include_usage ? responseUsage : undefined,
            }),
          );
          res.write('data: [DONE]\n\n');
          res.end();
          if (responseJob.metadata.cacheEnabled) {
            sendCacheStore(responseJob.id, [...effectiveMessages, { role: 'assistant', content: toolResponse.content }]);
          }
          return;
        }

        res.json(
          chatCompletionPayload({
            id: responseJob.id,
            created: responseJob.created,
            model: responseJob.model,
            text: toolResponse.content,
            usage: responseUsage,
          }),
        );
        if (responseJob.metadata.cacheEnabled) {
          sendCacheStore(responseJob.id, [...effectiveMessages, { role: 'assistant', content: toolResponse.content }]);
        }
        return;
      }

      job.metadata.finishReason = 'stop';
      if (stream) {
        const trailingContent = extractDelta(job.outputText, text);
        if (trailingContent) {
          writeSse(
            res,
            chatChunkPayload({
              id: job.id,
              created: job.created,
              model: job.model,
              delta: { content: trailingContent },
            }),
          );
        }
        writeSse(
          res,
          chatChunkPayload({
            id: job.id,
            created: job.created,
            model: job.model,
            delta: {},
            finishReason: 'stop',
            usage: streamOptions?.include_usage ? usage : undefined,
          }),
        );
        res.write('data: [DONE]\n\n');
        res.end();
        if (job.metadata.cacheEnabled) {
          sendCacheStore(job.id, [...effectiveMessages, { role: 'assistant', content: text }]);
        }
        return;
      }

      res.json(
        chatCompletionPayload({
          id: job.id,
          created: job.created,
          model: job.model,
          text,
          usage,
        }),
      );
      if (job.metadata.cacheEnabled) {
        sendCacheStore(job.id, [...effectiveMessages, { role: 'assistant', content: text }]);
      }
    } catch (error) {
      if (job?.metadata?.cacheEnabled) {
        sendCacheDiscard(job.id);
      }
      const status = error.status || 500;
      const type = error.type || 'api_error';

      if (stream && res.headersSent && !res.writableEnded) {
        writeSse(res, { error: { message: error.message, type } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.status(status).json(openAiError(error.message, type, error.code));
    }
  }

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use('/vendor/marked', express.static(markedDir));
  app.use(express.static(publicDir));

  app.get('/api/status', (_req, res) => {
    res.json(getStatusPayload());
  });

  app.get('/api/bridge-config', (_req, res) => {
    res.json({
      token: state.bridgeToken,
    });
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      browserConnected: Boolean(state.browser),
      activeRequests: state.stats.active,
    });
  });

  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [modelPayload()],
    });
  });

  app.get('/v1/models/:modelId', (req, res) => {
    if (req.params.modelId !== DEFAULT_MODEL) {
      res.status(404).json(openAiError(`The model "${req.params.modelId}" does not exist.`, 'invalid_request_error'));
      return;
    }

    res.json(modelPayload(req.params.modelId));
  });

  app.post('/v1/chat/completions', (req, res) => {
    handleOpenAiCompletion(req, res);
  });

  app.post('/api/chat/sessions', (_req, res) => {
    const session = createChatSession();
    res.status(201).json({ session: serializeChatSession(session) });
  });

  app.get('/api/chat/sessions/:sessionId', (req, res) => {
    const session = state.sessions.get(req.params.sessionId);

    if (!session) {
      res.status(404).json({ error: { message: 'Chat session not found.' } });
      return;
    }

    res.json({ session: serializeChatSession(session) });
  });

  app.post('/api/chat/sessions/:sessionId/messages', async (req, res) => {
    const session = state.sessions.get(req.params.sessionId);

    if (!session) {
      res.status(404).json({ error: { message: 'Chat session not found.' } });
      return;
    }

    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const stream = req.body?.stream === true;
    if (!content) {
      res.status(400).json({ error: { message: 'Message content is required.' } });
      return;
    }

    const userMessage = { role: 'user', content };
    session.messages.push(userMessage);
    session.updatedAt = new Date().toISOString();
    let job;

    try {
      job = dispatchGeneration({
        model: DEFAULT_MODEL,
        messages: session.messages,
        metadata: {
          source: 'hosted-chat',
          stream,
          messageCount: session.messages.length,
          toolsProvided: 0,
          cacheEnabled: canUsePromptCache(session.messages, 0),
          awaitServerStore: false,
        },
        onChunk: stream
          ? ({ delta }) => {
              if (res.writableEnded) {
                return;
              }

              writeSse(res, {
                type: 'assistant-delta',
                delta,
              });
            }
          : undefined,
      });

      if (stream) {
        openSse(res);
        writeSse(res, {
          type: 'assistant-start',
          sessionId: session.id,
        });
      }

      const { text, usage } = await job.result;
      session.messages.push({ role: 'assistant', content: text });
      session.updatedAt = new Date().toISOString();

      if (stream) {
        const trailingContent = extractDelta(job.outputText, text);
        if (trailingContent) {
          writeSse(res, {
            type: 'assistant-delta',
            delta: trailingContent,
          });
        }
        writeSse(res, {
          type: 'assistant-complete',
          session: serializeChatSession(session),
          usage,
        });
        res.write('data: [DONE]\n\n');
        res.end();
        if (job.metadata.cacheEnabled) {
          sendCacheStore(job.id, [...session.messages]);
        }
        return;
      }

        res.json({
          session: serializeChatSession(session),
          usage,
        });
        if (job.metadata.cacheEnabled) {
          sendCacheStore(job.id, [...session.messages]);
        }
      } catch (error) {
        if (job?.metadata?.cacheEnabled) {
          sendCacheDiscard(job.id);
        }
        const lastMessage = session.messages.at(-1);
      if (lastMessage === userMessage) {
        session.messages.pop();
        session.updatedAt = new Date().toISOString();
      }

      const status = error.status || 500;
      const type = error.type || 'api_error';

      if (stream && res.headersSent && !res.writableEnded) {
        writeSse(res, {
          type: 'error',
          error: openAiError(error.message, type, error.code).error,
        });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.status(status).json(openAiError(error.message, type, error.code));
    }
  });

  wss.on('connection', (ws, req) => {
    if (!isAllowedBridgeRequest(req)) {
      ws.close(1008, 'Invalid bridge credentials');
      return;
    }

      if (state.browser && state.browser !== ws) {
        for (const job of Array.from(state.jobs.values())) {
          rejectJob(job, 503, 'The browser bridge was replaced while requests were in progress.', 'bridge_replaced', 'bridge_replaced');
        }
        state.browser.close(4000, 'Replaced by a new browser session');
      }

    state.browser = ws;
    state.browserInfo = {
      connectedAt: new Date().toISOString(),
    };
    addLog('info', 'Browser bridge connected');
    sendBrowserState();

    ws.on('message', (rawData) => {
      let payload;

      try {
        payload = JSON.parse(String(rawData));
      } catch {
        addLog('warn', 'Received invalid JSON from browser bridge');
        return;
      }

      if (payload?.type === 'browser-ready') {
        state.browserInfo = {
          ...state.browserInfo,
          userAgent: payload.userAgent ?? null,
          promptApiAvailable: Boolean(payload.promptApiAvailable),
          location: payload.location ?? null,
        };
        addLog('info', 'Browser bridge is ready', {
          promptApiAvailable: Boolean(payload.promptApiAvailable),
        });
        sendBrowserState();
        return;
      }

      if (payload?.type === 'job-started') {
        const job = state.jobs.get(payload.requestId);
        if (job) {
          job.browserUsage = {
            ...job.browserUsage,
            ...(payload.usage ?? {}),
          };
          armJobTimeout(job);
        }

        addLog('info', `Browser started request: ${payload.requestId}`, {
          promptTokens: Number.isFinite(payload?.usage?.prompt_tokens) ? payload.usage.prompt_tokens : null,
          contextWindow: Number.isFinite(payload?.usage?.context_window) ? payload.usage.context_window : null,
          trimmedMessages: Number.isFinite(payload?.usage?.trimmed_messages) ? payload.usage.trimmed_messages : 0,
          cacheHit: Boolean(payload?.usage?.cache_hit),
          cachePrefixMessages: Number.isFinite(payload?.usage?.cache_prefix_messages)
            ? payload.usage.cache_prefix_messages
            : 0,
          cacheSuffixMessages: Number.isFinite(payload?.usage?.cache_suffix_messages)
            ? payload.usage.cache_suffix_messages
            : 0,
          cacheEntries: Number.isFinite(payload?.usage?.cache_entries) ? payload.usage.cache_entries : 0,
          cacheAwaitingStore: Boolean(payload?.usage?.cache_awaiting_store),
        });
        return;
      }

      if (payload?.type === 'job-chunk') {
        const job = state.jobs.get(payload.requestId);
        if (!job || job.finished) {
          return;
        }

        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (!delta) {
          return;
        }

        job.outputText += delta;
        job.chunkCount += 1;
        armJobTimeout(job);
        job.onChunk?.({ job, delta });
        return;
      }

      if (payload?.type === 'job-complete') {
        const job = state.jobs.get(payload.requestId);
        if (!job) {
          return;
        }

        resolveJob(job, typeof payload.text === 'string' ? payload.text : job.outputText, payload.usage, payload.timings);
        return;
      }

      if (payload?.type === 'job-error') {
        const job = state.jobs.get(payload.requestId);
        if (!job) {
          return;
        }

        const status = payload.code === 'context_length_exceeded' ? 400 : 500;
        const type = payload.code === 'context_length_exceeded' ? 'invalid_request_error' : 'bridge_error';
        rejectJob(
          job,
          status,
          payload.error || 'The browser bridge failed to complete the request.',
          type,
          payload.code ?? null,
          payload.details ?? null,
        );
      }
    });

    ws.on('close', () => {
      if (state.browser === ws) {
        state.browser = null;
        state.browserInfo = null;
        addLog('warn', 'Browser bridge disconnected');

        for (const job of Array.from(state.jobs.values())) {
          rejectJob(job, 503, 'The browser bridge disconnected while a request was in progress.', 'bridge_disconnected', 'bridge_disconnected');
        }
      }
    });
  });

  async function listen(port = config.port, host = config.host) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('error', onError);
        reject(error);
      };

      server.on('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        resolve();
      });
    });

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${host}:${actualPort}`;

    addLog('info', `Server listening on ${url}`);
    console.log(`Bridge listening at ${url}`);
    console.log(`OpenAI endpoint: ${url}/v1/chat/completions`);

    if (config.openBrowser) {
      try {
        tryOpenBrowser(url);
        addLog('info', `Opened browser at ${url}`);
      } catch (error) {
        addLog('warn', 'Failed to open browser automatically', { message: error.message });
      }
    }

    return server;
  }

  async function close() {
    for (const job of Array.from(state.jobs.values())) {
      rejectJob(job, 503, 'The server is shutting down.', 'server_shutdown', 'server_shutdown');
    }

    await new Promise((resolve) => {
      wss.clients.forEach((client) => client.close(1001, 'Server shutting down'));
      wss.close(() => resolve());
    });

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return {
    app,
    server,
    state,
    listen,
    close,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const bridgeServer = createBridgeServer(cliOptions);

  bridgeServer.listen().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
