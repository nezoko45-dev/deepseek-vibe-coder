const API_URL = "https://api.deepseek.com/chat/completions";

export async function askDeepSeek(env, messages) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || "deepseek-v4-pro",
      messages,
      temperature: 0.15,
      response_format: { type: "json_object" }
    })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 1200)}`);

  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no message content");

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("DeepSeek returned invalid JSON");
    return JSON.parse(match[0]);
  }
}
