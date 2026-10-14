/**
 * OFERENDA DIGITAL — Cloudflare Worker (Versão Limpa e Direta)
 */

const SYSTEM_PROMPT = `Você é um guardião espiritual respeitoso das tradições de Umbanda e Candomblé.
Analise o pedido do visitante e classifique com máximo cuidado e respeito à religiosidade de matriz africana.

REGRAS DE CLASSIFICAÇÃO:
APROVADO: abertura de caminhos, saúde própria, proteção espiritual, prosperidade, amor saudável (livre arbítrio), agradecimento, cura, paz, equilíbrio
NEGADO: amarração forçada, prejudicar terceiros, vingança, mal-feito, magia negra explícita, pedidos com nome de vítima, intenções violentas ou manipuladoras

TIPOS disponíveis (use apenas um):
caminhos | saude | amor | prosperidade | protecao | gratidao

Responda SOMENTE em JSON puro, sem texto extra, sem markdown:
{
  "status": "APROVADO" ou "NEGADO",
  "tipo": "caminhos",
  "texto_ritual": "2-3 linhas acolhedoras e respeitosas sobre o pedido (somente se APROVADO)",
  "mensagem_negacao": "texto acolhedor sem julgamento explicando o motivo (somente se NEGADO)",
  "elementos": ["elemento1", "elemento2", "elemento3"]
}`;

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const headers = corsHeaders(env);

    try {
      if (pathname === "/classificar" && request.method === "POST") {
        const bodyData = await request.json();
        const texto = bodyData.texto;

        if (!texto || texto.trim().length < 5) {
          return new Response(JSON.stringify({ error: "Texto muito curto" }), { status: 400, headers });
        }

        if (!env.GEMINI_API_KEY) {
          return new Response(JSON.stringify({ error: "Chave da API do Gemini não configurada no Cloudflare" }), { status: 500, headers });
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
        
        const geminiPayload = {
          contents: [
            {
              role: "user",
              parts: [{ text: `${SYSTEM_PROMPT}\n\nPedido do visitante: "${texto.trim()}"` }]
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
          body: JSON.stringify(geminiPayload)
        });

        if (!res.ok) {
          const errText = await res.text();
          return new Response(JSON.stringify({ error: "Erro na API do Google", details: errText }), { status: 500, headers });
        }

        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        
        let clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
        const inicioJson = clean.indexOf("{");
        const fimJson = clean.lastIndexOf("}");
        if (inicioJson !== -1 && fimJson !== -1) {
          clean = clean.substring(inicioJson, fimJson + 1);
        }

        const resultadoJson = JSON.parse(clean);
        return new Response(JSON.stringify(resultadoJson), { status: 200, headers });
      }

      // Rota genérica para outras requisições
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });

    } catch (err) {
      return new Response(JSON.stringify({ error: "Erro interno no Worker", details: err.message }), { status: 500, headers });
    }
  }
};
