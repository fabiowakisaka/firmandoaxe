/**
 * OFERENDA DIGITAL — Cloudflare Worker (Versão Definitiva e Estável)
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

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}


// ─── GOOGLE SHEETS (conta de serviço) ─────────────────────────
const SHEET_ID_PADRAO = "1H9Zw-bZ1cAupqvoVVhXJ7IVEjdg_j40g9g3Jv9tGsyI";
const ABA_OFERENDAS = "oferendas";
const ABA_NEGADOS = "pedidos_negados";
const TIPOS_VALIDOS = ["caminhos", "saude", "amor", "prosperidade", "protecao", "gratidao"];

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(env) {
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY) {
    throw new Error("GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY não configurados no Cloudflare");
  }
  const agora = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.GOOGLE_SA_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600
  };
  const unsigned = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claim));

  const pem = env.GOOGLE_SA_PRIVATE_KEY
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + "." + b64url(sig);

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Falha ao autenticar no Google: " + JSON.stringify(d));
  return d.access_token;
}

async function sheetsAppend(env, aba, linha) {
  const token = await getAccessToken(env);
  const id = env.SHEET_ID || SHEET_ID_PADRAO;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(aba + "!A:Z")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [linha] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Sheets append (" + aba + "): " + JSON.stringify(d));
  return d;
}

async function sheetsLer(env, aba) {
  const token = await getAccessToken(env);
  const id = env.SHEET_ID || SHEET_ID_PADRAO;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(aba + "!A:J")}`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const d = await r.json();
  if (!r.ok) throw new Error("Sheets leitura (" + aba + "): " + JSON.stringify(d));
  return d.values || [];
}

function limpar(v, max) {
  return String(v == null ? "" : v).slice(0, max);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const headers = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    try {
      if (pathname === "/classificar" && request.method === "POST") {
        const bodyData = await request.json();
        const texto = bodyData.texto;

        if (!texto || texto.trim().length < 5) {
          return new Response(JSON.stringify({ error: "Texto muito curto" }), { status: 400, headers });
        }

        if (!env.GEMINI_API_KEY) {
          return new Response(JSON.stringify({ error: "GEMINI_API_KEY não configurada no Cloudflare" }), { status: 500, headers });
        }

        // Modelos em ordem de preferência (podem ser trocados no Cloudflare via GEMINI_MODEL)
        const modelos = [env.GEMINI_MODEL || "gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3.1-flash"];

        const geminiPayload = {
          contents: [
            {
              role: "user",
              parts: [{ text: `${SYSTEM_PROMPT}\n\nPedido do visitante: "${texto.trim()}"` }]
            }
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4096
          }
        };

        let res, data;
        for (const modelo of modelos) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${env.GEMINI_API_KEY}`;
          // até 3 tentativas por modelo em caso de sobrecarga (503/429)
          for (let tentativa = 0; tentativa < 3; tentativa++) {
            res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(geminiPayload)
            });
            data = await res.json();
            if (res.ok) break;
            if (res.status === 503 || res.status === 429) {
              await new Promise(r => setTimeout(r, 800 * (tentativa + 1)));
              continue;
            }
            break; // outro erro (ex.: 404): passa para o próximo modelo
          }
          if (res.ok) break;
        }

        if (!res.ok) {
          return new Response(JSON.stringify({ error: "Erro na API do Google", details: data }), { status: 500, headers });
        }

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

      // ── Grava oferenda aprovada na planilha ──
      if (pathname === "/salvar" && request.method === "POST") {
        const o = await request.json();
        const lat = parseFloat(o.lat), lng = parseFloat(o.lng);
        if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          return new Response(JSON.stringify({ error: "Coordenadas inválidas" }), { status: 400, headers });
        }
        const tipo = TIPOS_VALIDOS.includes(o.tipo) ? o.tipo : "caminhos";
        const agora = new Date();
        const expira = new Date(agora.getTime() + 72 * 3600 * 1000);
        const elementos = Array.isArray(o.elementos) ? o.elementos.join(" | ") : limpar(o.elementos, 300);
        // ordem das colunas: id, data_criacao, intencao, tipo, lat, lng, texto_ritual, elementos, status_ativa, expira_em
        await sheetsAppend(env, ABA_OFERENDAS, [
          limpar(o.id, 64), agora.toISOString(), limpar(o.intencao, 300), tipo,
          lat, lng, limpar(o.texto_ritual, 1500), elementos, "1", expira.toISOString()
        ]);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }

      // ── Grava pedido negado ──
      if (pathname === "/salvar-negado" && request.method === "POST") {
        const o = await request.json();
        await sheetsAppend(env, ABA_NEGADOS, [
          limpar(o.ts, 40) || new Date().toISOString(), limpar(o.texto, 300), o.lat ?? "", o.lng ?? ""
        ]);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }

      // ── Lista oferendas ativas (só campos públicos) ──
      if (pathname === "/oferendas" && request.method === "GET") {
        const linhas = await sheetsLer(env, ABA_OFERENDAS);
        const agora = Date.now();
        const ativas = linhas.slice(1)
          .filter(r => r[8] === "1" && (!r[9] || new Date(r[9]).getTime() > agora))
          .map(r => ({ lat: parseFloat(r[4]), lng: parseFloat(r[5]), tipo: r[3], texto_ritual: r[6], expira_em: r[9] }))
          .filter(o => isFinite(o.lat) && isFinite(o.lng));
        return new Response(JSON.stringify(ativas), { status: 200, headers });
      }

      // ── Busca uma oferenda pelo id (link compartilhado) ──
      // Não devolve a "intencao" (pedido privado do visitante), só o que é público.
      if (pathname === "/buscar-oferenda" && request.method === "GET") {
        const id = new URL(request.url).searchParams.get("id") || "";
        if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) {
          return new Response(JSON.stringify({ error: "id inválido" }), { status: 400, headers });
        }
        const linhas = await sheetsLer(env, ABA_OFERENDAS);
        const r = linhas.slice(1).find(x => x[0] === id);
        if (!r) return new Response(JSON.stringify({ error: "Não encontrada" }), { status: 404, headers });
        const expiraMs = r[9] ? new Date(r[9]).getTime() : null;
        return new Response(JSON.stringify({
          id: r[0],
          tipo: r[3],
          lat: parseFloat(r[4]),
          lng: parseFloat(r[5]),
          texto_ritual: r[6] || "",
          elementos: (r[7] || "").split(" | ").filter(Boolean),
          criada_em: r[1] || "",
          expira_em: r[9] || "",
          expirada: r[8] !== "1" || (expiraMs !== null && expiraMs <= Date.now())
        }), { status: 200, headers });
      }

      // Rota padrão para salvamentos ou requisições gerais sem quebrar o site
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });

    } catch (err) {
      return new Response(JSON.stringify({ error: "Erro interno no Worker", details: err.message }), { status: 500, headers });
    }
  }
};
