import type { MemoryProvider } from "../types.js";
import { getEnvVar } from "../config.js";
import { fetchWithTimeout } from "./_fetch.js";

export class OpenRouterProvider implements MemoryProvider {
  name: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;
  private reasoningEffort?: string;

  constructor(
    apiKey: string,
    model: string,
    maxTokens: number,
    baseUrl: string,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.baseUrl = baseUrl;
    this.name = baseUrl.includes("openrouter") ? "openrouter" : "gemini";
    // This class also backs the Gemini OpenAI-compat endpoint, which has its
    // own reasoning controls — keep the OpenRouter knob off that path.
    this.reasoningEffort =
      this.name === "openrouter"
        ? getEnvVar("OPENROUTER_REASONING_EFFORT") || undefined
        : undefined;
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  private async call(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (this.reasoningEffort) {
      body.reasoning_effort = this.reasoningEffort;
    }

    const response = await fetchWithTimeout(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.baseUrl.includes("openrouter")
          ? { "HTTP-Referer": "https://github.com/rohitg00/agentmemory" }
          : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${this.name} API error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const choices = data.choices as
      | Array<{
          message?: {
            content?: string;
            reasoning?: string;
            reasoning_content?: string;
          };
        }>
      | undefined;
    const message = choices?.[0]?.message;
    const content = message?.content;
    if (content) {
      return content;
    }
    // Fallback: thinking models can spend the whole output budget on reasoning
    // and return no content. Mirrors the OpenAI provider (#627); reachable
    // here whenever OPENROUTER_REASONING_EFFORT is set.
    const reasoning = message?.reasoning ?? message?.reasoning_content;
    if (reasoning) {
      return reasoning;
    }
    throw new Error(
      `${this.name} returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
}
