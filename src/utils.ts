export function generateId(): string {
    return Math.random().toString(36).substring(2)
}

export function sendMessageStart(controller: ReadableStreamDefaultController): void {
    const event = `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: generateId(),
            type: 'message',
            role: 'assistant',
            content: []
        }
    })}\n\n`
    controller.enqueue(new TextEncoder().encode(event))
}

export function sendMessageStop(controller: ReadableStreamDefaultController): void {
    const event = `event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop'
    })}\n\n`
    controller.enqueue(new TextEncoder().encode(event))
}

export function processTextPart(text: string, index: number): string[] {
    const events: string[] = []

    events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: {
                type: 'text',
                text: ''
            }
        })}\n\n`
    )

    events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: {
                type: 'text_delta',
                text
            }
        })}\n\n`
    )

    events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index
        })}\n\n`
    )

    return events
}

export function processToolUsePart(functionCall: { name: string; args: any }, index: number): string[] {
    const events: string[] = []
    const toolUseId = generateId()

    events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: {
                type: 'tool_use',
                id: toolUseId,
                name: functionCall.name,
                input: {}
            }
        })}\n\n`
    )

    events.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(functionCall.args)
            }
        })}\n\n`
    )

    events.push(
        `event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop',
            index
        })}\n\n`
    )

    return events
}

export function buildUrl(baseUrl: string, endpoint: string): string {
    let finalUrl = baseUrl
    if (!finalUrl.endsWith('/')) {
        finalUrl += '/'
    }
    return finalUrl + endpoint
}

export async function processProviderStream(
    providerResponse: Response,
    processLine: (
        jsonStr: string,
        textIndex: number,
        toolIndex: number
    ) => { events: string[]; textBlockIndex: number; toolUseBlockIndex: number } | null
): Promise<Response> {
    const stream = new ReadableStream({
        async start(controller) {
            const reader = providerResponse.body?.getReader()
            if (!reader) {
                controller.close()
                return
            }

            const decoder = new TextDecoder()
            let buffer = ''
            let textBlockIndex = 0
            let toolUseBlockIndex = 0

            sendMessageStart(controller)

            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break

                    const chunk = buffer + decoder.decode(value, { stream: true })
                    const lines = chunk.split('\n')

                    buffer = lines.pop() || ''

                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue

                        const jsonStr = line.slice(6)
                        if (jsonStr === '[DONE]') continue

                        const result = processLine(jsonStr, textBlockIndex, toolUseBlockIndex)
                        if (result) {
                            textBlockIndex = result.textBlockIndex
                            toolUseBlockIndex = result.toolUseBlockIndex

                            for (const event of result.events) {
                                controller.enqueue(new TextEncoder().encode(event))
                            }
                        }
                    }
                }
            } finally {
                if (buffer.trim()) {
                    const result = processLine(buffer.slice(6), textBlockIndex, toolUseBlockIndex)
                    if (result) {
                        for (const event of result.events) {
                            controller.enqueue(new TextEncoder().encode(event))
                        }
                    }
                }
                reader.releaseLock()
                sendMessageStop(controller)
                controller.close()
            }
        }
    })

    return new Response(stream, {
        status: providerResponse.status,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        }
    })
}

export function cleanJsonSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') {
        return schema
    }

    // Gemini 不支持的 JSON Schema 字段
    const unsupportedKeys = [
        '$schema', 'additionalProperties', 'title', 'examples',
        'propertyNames', 'exclusiveMinimum', 'exclusiveMaximum',
        'const', 'if', 'then', 'else', 'allOf', 'not',
        'unevaluatedProperties', 'unevaluatedItems', 'contains',
        'minContains', 'maxContains', 'deprecated', 'readOnly', 'writeOnly'
    ]

    const cleaned = { ...schema }

    // 处理 anyOf：转换为 Gemini 支持的格式
    if (cleaned.anyOf) {
        const types = cleaned.anyOf
            .map((s: any) => s.type)
            .filter((t: any) => t && t !== 'null')
        if (types.length === 1) {
            cleaned.type = types[0]
        }
        delete cleaned.anyOf
    }

    for (const key of unsupportedKeys) {
        delete cleaned[key]
    }

    // 递归处理嵌套对象
    for (const key in cleaned) {
        if (key === 'properties' && typeof cleaned[key] === 'object') {
            const cleanedProps: any = {}
            for (const prop in cleaned[key]) {
                cleanedProps[prop] = cleanJsonSchema(cleaned[key][prop])
            }
            cleaned[key] = cleanedProps
        } else if (key === 'items' && typeof cleaned[key] === 'object') {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        } else if (typeof cleaned[key] === 'object' && !Array.isArray(cleaned[key])) {
            cleaned[key] = cleanJsonSchema(cleaned[key])
        } else if (Array.isArray(cleaned[key])) {
            cleaned[key] = cleaned[key].map((item: any) =>
                typeof item === 'object' ? cleanJsonSchema(item) : item
            )
        }
    }

    return cleaned
}
