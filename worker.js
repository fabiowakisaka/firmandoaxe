/**
 * OFERENDA DIGITAL — Cloudflare Worker
 * ─────────────────────────────────────
 * Proxy seguro entre o frontend (GitHub Pages) e:
 *  - Google Gemini API (classificação NLP)
 *  - Google Sheets API (leitura/escrita de dados)
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler deploy
 *
 * Variáveis de ambiente (wrangler secret put NOME):
 *   GEMINI_API_KEY        → chave da Gemini API
 *   GOOGLE_SA_EMAIL       → e-mail da Service Account
 *   GOOGLE_SA_PRIVATE_KEY → chave privada RSA da Service Account
 *   SHEET_ID              → ID da planilha Google Sheets
 *   ALLOWED_ORIGIN        → https://seusite.github.io
 */

// ─── SYSTEM PROMPT NLP ──────────────────────────────────────
const SYSTEM_PROMPT = `Você é um guardião espiritual respeitoso das tradições de Umbanda e Candomblé.
Analise o pedido do visitante e classifique com máximo cuidado e respeito à religiosidade de matriz africana.

REGRAS DE CLASSIFICAÇÃO:
APROVADO: abertura de caminhos, saúde própria, proteção espiritual, prosperidade, amor saudável (livre arbítrio), agradecimento, cura, paz, equilíbrio
NEGADO: amarração forçada, prejudicar terceiros, vingança, mal-feito, magia negra explícita, pedidos com nome de vítima, intenções violentas ou manipuladoras

TIPOS disponíveis (use apenas um):
caminhos | saude | amor | prosperidade | protecao | gratidao

Responda SOMENTE em JSON válido, sem texto extra, sem markdown:
{
  "status": "APROVADO" ou "NEGADO",
  "tipo": "caminhos" (ou outro tipo — somente se APROVADO),
  "texto_ritual": "2-3 linhas acolhedoras e respeitosas sobre o pedido (somente se APROVADO)",
  "mensagem_negacao": "texto acolhedor sem julgamento explicando o motivo (somente se NEGADO)",
  "elementos": ["elemento1", "elemento2", "elemento3"] (somente se APROVADO)
}`;

// ─── CORS HEADERS ────────────────────────────────────────────
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin":  env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

// ─── MAIN HANDLER ────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const headers = corsHeaders(env);

    try {
      // ── POST /classificar ──────────────────────────────────
      if (pathname === "/classificar" && request.method === "POST") {
        const { texto } = await request.json();

        if (!texto || texto.trim().length < 5) {
          return json({ error: "Texto muito curto" }, 400, headers);
        }

        const resultado = await classificarComGemini(texto.trim(), env);
        return json(resultado, 200, headers);
      }

      // ── POST /salvar ───────────────────────────────────────
      if (pathname === "/salvar" && request.method === "POST") {
        const oferenda = await request.json();
        await salvarOferenda(oferenda, env);
        return json({ ok: true }, 200, headers);
      }

      // ── POST /salvar-praticante ────────────────────────────
      if (pathname === "/salvar-praticante" && request.method === "POST") {
        const dados = await request.json();
        await salvarPraticante(dados, env);
        return json({ ok: true }, 200, headers);
      }

      // ── POST /salvar-avaliacao ─────────────────────────────
      if (pathname === "/salvar-avaliacao" && request.method === "POST") {
        const avaliacao = await request.json();
        await salvarAvaliacao(avaliacao, env);
        return json({ ok: true }, 200, headers);
      }

      // ── GET /praticantes?lat=X&lng=Y&raio=Z ───────────────
      if (pathname === "/praticantes" && request.method === "GET") {
        const url   = new URL(request.url);
        const lat   = parseFloat(url.searchParams.get("lat")  || "-23.55");
        const lng   = parseFloat(url.searchParams.get("lng")  || "-46.63");
        const raio  = parseFloat(url.searchParams.get("raio") || "30");
        const lista = await buscarPraticantes(lat, lng, raio, env);
        return json(lista, 200, headers);
      }

      return json({ error: "Rota não encontrada" }, 404, headers);

    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: "Erro interno", detail: err.message }, 500, headers);
    }
  }
};

// ─── HELPERS ─────────────────────────────────────────────────
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}

// ─── GEMINI API ──────────────────────────────────────────────
async function classificarComGemini(texto, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  const body = {
    contents: [{
      parts: [{ text: `${SYSTEM_PROMPT}\n\nPedido do visitante: "${texto}"` }]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512
    }
  };

  const res  = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  // Limpar possível markdown code fence
  const clean = raw.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error("Resposta inválida da IA: " + clean.substring(0, 100));
  }
}

// ─── GOOGLE SHEETS: AUTH ─────────────────────────────────────
/**
 * Gera um JWT para autenticar na Google API com Service Account.
 * O Cloudflare Workers suporta a Web Crypto API nativamente.
 */
async function getGoogleToken(env) {
  const now  = Math.floor(Date.now() / 1000);
  const exp  = now + 3600;

  const header  = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payload = btoa(JSON.stringify({
    iss:   env.GOOGLE_SA_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp
  })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const signingInput = `${header}.${payload}`;

  // Importar chave privada RSA
  const pemKey = env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n");
  const pemBody = pemKey.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const der  = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const key  = await crypto.subtle.importKey(
    "pkcs8", der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(signingInput)
  );

  const b64sig = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${signingInput}.${b64sig}`;

  // Trocar JWT por access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

// ─── GOOGLE SHEETS: APPEND ───────────────────────────────────
async function appendRow(token, sheetId, aba, valores) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${aba}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify({ values: [valores] })
  });
  if (!res.ok) throw new Error(`Sheets append error: ${await res.text()}`);
  return res.json();
}

async function getRows(token, sheetId, aba) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${aba}!A1:Z1000`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Sheets read error: ${await res.text()}`);
  const data = await res.json();
  const [headers, ...rows] = data.values || [[]];
  return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ""])));
}

// ─── SALVAR OFERENDA ─────────────────────────────────────────
async function salvarOferenda(o, env) {
  const token  = await getGoogleToken(env);
  const agora  = new Date().toISOString();
  const expira = new Date(Date.now() + 72 * 36e5).toISOString();

  const linha = [
    o.id            || crypto.randomUUID(),
    agora,
    o.intencao      || "",
    o.tipo          || "caminhos",
    o.lat           || "",
    o.lng           || "",
    o.texto_ritual  || "",
    Array.isArray(o.elementos) ? o.elementos.join(", ") : (o.elementos || ""),
    1,              // status_ativa
    expira
  ];

  await appendRow(token, env.SHEET_ID, "oferendas", linha);
}

// ─── SALVAR PRATICANTE ───────────────────────────────────────
async function salvarPraticante(p, env) {
  const token = await getGoogleToken(env);
  const linha = [
    crypto.randomUUID(),
    p.nome         || "",
    p.tradicao     || "",
    p.descricao    || "",
    p.cidade       || "",
    p.lat          || "",
    p.lng          || "",
    p.raio_km      || 20,
    p.whatsapp     || "",
    p.plano        || "basico",
    "",             // nota_media (calculada depois)
    0,              // total_votos
    1,              // ativo
    0,              // destaque
    new Date().toISOString()
  ];
  await appendRow(token, env.SHEET_ID, "praticantes", linha);
}

// ─── SALVAR AVALIAÇÃO ────────────────────────────────────────
async function salvarAvaliacao(a, env) {
  const token = await getGoogleToken(env);
  const linha = [
    crypto.randomUUID(),
    a.id_praticante || "",
    a.id_pedido     || "",
    a.nota          || 0,
    a.comentario    || "",
    new Date().toISOString()
  ];
  await appendRow(token, env.SHEET_ID, "avaliacoes", linha);
}

// ─── BUSCAR PRATICANTES POR DISTÂNCIA ────────────────────────
async function buscarPraticantes(lat, lng, raioKm, env) {
  const token      = await getGoogleToken(env);
  const praticantes = await getRows(token, env.SHEET_ID, "praticantes");

  return praticantes
    .filter(p => p.ativo === "1")
    .map(p => ({
      ...p,
      distancia_km: haversine(lat, lng, parseFloat(p.lat || 0), parseFloat(p.lng || 0))
    }))
    .filter(p => p.distancia_km <= raioKm)
    .sort((a, b) => {
      // Destaques primeiro, depois por nota, depois por distância
      if (b.destaque !== a.destaque) return b.destaque - a.destaque;
      if (b.nota_media !== a.nota_media) return parseFloat(b.nota_media || 0) - parseFloat(a.nota_media || 0);
      return a.distancia_km - b.distancia_km;
    })
    .slice(0, 10);
}

// ─── HAVERSINE (distância em km) ─────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
