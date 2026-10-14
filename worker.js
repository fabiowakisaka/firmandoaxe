async function classificarComGemini(texto, env) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não está configurada.");
  }

  // Usando o modelo correto e atual da API v1beta
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${SYSTEM_PROMPT}\n\nPedido do visitante: "${texto}"` }]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 512
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const erroTxt = await res.text();
    throw new Error(`Erro na API do Gemini (${res.status}): ${erroTxt}`);
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  
  let clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  const inicioJson = clean.indexOf("{");
  const fimJson = clean.lastIndexOf("}");
  if (inicioJson !== -1 && fimJson !== -1) {
    clean = clean.substring(inicioJson, fimJson + 1);
  }

  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error("Falha ao interpretar JSON da IA: " + clean);
  }
}
