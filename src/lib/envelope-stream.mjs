/**
 * 增量读取工具协议中的最终正文。
 * 只有前置元数据明确声明 done/ask 且工具列表为空时才输出，工具参数始终留给完整解析器校验。
 * 旧格式、工具轮次和非法 JSON 自动退回原有缓冲路径，不向客户端泄漏协议字段。
 */
export function envelopeContentStream() {
  let header = ''
  let depth = 0
  let quoted = false
  let escaped = false
  let keyToken = ''
  let readingKey = false
  let key = ''
  let expectKey = false
  let expectValue = false
  let content = false
  let stopped = false
  let escape = ''
  let highSurrogate = ''
  let whitespace = ''
  let started = false

  // 延迟空白和 UTF-16 高代理项，避免分片边界造成多余首尾空白或截断表情。
  const visible = (value) => {
    let result = ''
    for (const char of value) {
      if (/\s/u.test(char)) {
        if (started) whitespace += char
      } else {
        result += whitespace.replace(/\n{3,}/g, '\n\n') + char
        whitespace = ''
        started = true
      }
    }
    return result
  }
  const decoded = (char) => {
    if (char.length === 2) {
      const pending = highSurrogate
      highSurrogate = ''
      return visible(pending + char)
    }
    const code = char.charCodeAt(0)
    if (highSurrogate) {
      const first = highSurrogate
      highSurrogate = ''
      if (code >= 0xdc00 && code <= 0xdfff) return visible(first + char)
      return visible(first) + decoded(char)
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      highSurrogate = char
      return ''
    }
    return visible(char)
  }

  return {
    feed(delta) {
      let output = ''
      for (const char of delta) {
        if (stopped) break
        if (content) {
          if (escape) {
            escape += char
            if (escape === '\\u' || (escape.startsWith('\\u') && escape.length < 6)) continue
            try { output += decoded(JSON.parse(`"${escape}"`)) }
            catch { stopped = true }
            escape = ''
          } else if (char === '\\') escape = '\\'
          else if (char === '"') stopped = true
          else if (char.charCodeAt(0) < 0x20) stopped = true
          else output += decoded(char)
          continue
        }

        header += char
        // 非标准的巨大前缀不做推测性解析，避免工具参数占用额外的无界缓冲。
        if (header.length > 65536) { stopped = true; break }
        if (!depth) {
          if (char === '{') {
            const prefix = header.slice(0, -1).trim()
            if (prefix && !/^```(?:json)?$/i.test(prefix)) { stopped = true; break }
            header = '{'
            depth = 1
            expectKey = true
          }
          continue
        }
        if (quoted) {
          if (readingKey) keyToken += char
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') {
            quoted = false
            if (readingKey) {
              try { key = JSON.parse(keyToken) }
              catch { stopped = true }
              readingKey = false
              expectKey = false
            }
          }
          continue
        }
        if (char === '"') {
          if (depth === 1 && expectValue && key === 'content') {
            // 解析完整的前置元数据，而不是用正则匹配嵌套工具参数中的 content。
            try {
              const metadata = JSON.parse(header.slice(0, -1) + 'null}')
              content = ['done', 'ask'].includes(metadata.status) && Array.isArray(metadata.tool_calls) && metadata.tool_calls.length === 0
            } catch { content = false }
            if (!content) stopped = true
          } else {
            quoted = true
            readingKey = depth === 1 && expectKey
            keyToken = '"'
          }
          expectValue = false
        } else if (char === '{' || char === '[') {
          depth++
          expectValue = false
        } else if (char === '}' || char === ']') {
          if (--depth === 0) stopped = true
        } else if (depth === 1 && char === ':') expectValue = true
        else if (depth === 1 && char === ',') {
          expectKey = true
          expectValue = false
        } else if (!/\s/u.test(char)) expectValue = false
      }
      return output
    },
  }
}

/** 已显示的文字无法撤回：相同前缀只补尾部，修复后不同的答案作为补充输出。 */
export function remainingContent(finalContent, sentContent) {
  if (!sentContent) return finalContent
  if (finalContent.startsWith(sentContent)) return finalContent.slice(sentContent.length)
  if (!finalContent || sentContent.trim() === finalContent.trim()) return ''
  return `\n\n${finalContent}`
}
