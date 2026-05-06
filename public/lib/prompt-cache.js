export function flattenContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (part?.type === 'text') {
          if (typeof part.text === 'string') {
            return part.text;
          }

          if (typeof part.value === 'string') {
            return part.value;
          }
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function parseToolArguments(argumentsValue) {
  if (typeof argumentsValue !== 'string') {
    return argumentsValue ?? {};
  }

  try {
    return JSON.parse(argumentsValue);
  } catch {
    return argumentsValue;
  }
}

export function normalizeAssistantToolCalls(toolCalls = []) {
  return toolCalls.map((toolCall) => ({
    name: toolCall?.function?.name ?? toolCall?.name ?? '',
    arguments: parseToolArguments(toolCall?.function?.arguments ?? toolCall?.arguments),
  }));
}

export function normalizePromptMessage(message) {
  const role = typeof message?.role === 'string' ? message.role : 'user';
  if (role === 'assistant' && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    return JSON.stringify({
      type: 'tool_calls',
      tool_calls: normalizeAssistantToolCalls(message.tool_calls),
    });
  }

  if (role === 'tool') {
    const toolName =
      typeof message?.name === 'string'
        ? message.name
        : typeof message?.tool_call_id === 'string'
          ? message.tool_call_id
          : 'tool';
    return `TOOL ${toolName}: ${flattenContent(message?.content)}`;
  }

  return `${role.toUpperCase()}: ${flattenContent(message?.content)}`;
}

export function buildPromptSignature(messages = []) {
  return messages.map((message) => normalizePromptMessage(message));
}

export function buildPrompt(messages = []) {
  return buildPromptSignature(messages).join('\n\n');
}

export function findLongestExactPrefixMatch(entries, messages, minPrefixMessages = 1) {
  const signature = buildPromptSignature(messages);
  let bestEntry = null;

  for (const entry of entries) {
    const entrySignature = Array.isArray(entry?.signature) ? entry.signature : [];
    if (
      entrySignature.length < minPrefixMessages ||
      entrySignature.length >= signature.length ||
      (bestEntry && entrySignature.length <= bestEntry.signature.length)
    ) {
      continue;
    }

    let matches = true;
    for (let index = 0; index < entrySignature.length; index += 1) {
      if (entrySignature[index] !== signature[index]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      bestEntry = entry;
    }
  }

  return {
    signature,
    entry: bestEntry,
    prefixMessages: bestEntry?.signature.length ?? 0,
    suffixMessages: bestEntry ? signature.length - bestEntry.signature.length : signature.length,
  };
}
