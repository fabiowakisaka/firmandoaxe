"""
OFERENDA DIGITAL — Script de Expiração
=======================================
Roda via GitHub Actions diariamente às 00:00 BRT.
Lê a planilha de oferendas e muda status_ativa para 0
para todas as que já passaram do prazo.

Também recalcula a nota_media de cada praticante
com base nas avaliações recebidas.

Dependências: pip install gspread google-auth
Secrets: GOOGLE_CREDENTIALS (JSON da Service Account)
"""

import json
import os
import sys
from datetime import datetime, timezone

import gspread
from google.oauth2.service_account import Credentials

# ─── CONFIG ──────────────────────────────────────────────────
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly"
]
PLANILHA_NOME = "oferenda-digital"

# Índices das colunas (0-based) na aba "oferendas"
COL_ID            = 0
COL_DATA_CRIACAO  = 1
COL_INTENCAO      = 2
COL_TIPO          = 3
COL_LAT           = 4
COL_LNG           = 5
COL_TEXTO         = 6
COL_ELEMENTOS     = 7
COL_STATUS_ATIVA  = 8
COL_EXPIRA_EM     = 9

# Índices da aba "praticantes"
PRAT_ID           = 0
PRAT_NOTA_MEDIA   = 10
PRAT_TOTAL_VOTOS  = 11

# ─── AUTH ────────────────────────────────────────────────────
def autenticar():
    creds_raw = os.environ.get("GOOGLE_CREDENTIALS")
    if not creds_raw:
        print("❌ GOOGLE_CREDENTIALS não encontrado nos secrets.")
        sys.exit(1)

    creds_dict = json.loads(creds_raw)
    creds = Credentials.from_service_account_info(creds_dict, scopes=SCOPES)
    gc = gspread.authorize(creds)
    return gc.open(PLANILHA_NOME)

# ─── EXPIRAR OFERENDAS ───────────────────────────────────────
def expirar_oferendas(sh):
    ws      = sh.worksheet("oferendas")
    records = ws.get_all_values()

    if len(records) <= 1:
        print("ℹ️  Nenhuma oferenda encontrada.")
        return

    agora       = datetime.now(timezone.utc)
    expiradas   = 0
    erros       = 0

    print(f"🔍 Verificando {len(records) - 1} oferendas...")

    for i, row in enumerate(records[1:], start=2):  # linha 1 é header
        try:
            if len(row) <= COL_STATUS_ATIVA:
                continue

            status  = row[COL_STATUS_ATIVA].strip()
            expira_str = row[COL_EXPIRA_EM].strip() if len(row) > COL_EXPIRA_EM else ""

            if status != "1":
                continue  # já expirada ou inativa

            if not expira_str:
                continue  # sem data de expiração

            expira = datetime.fromisoformat(expira_str.replace("Z", "+00:00"))

            if agora >= expira:
                ws.update_cell(i, COL_STATUS_ATIVA + 1, 0)  # gspread usa índice 1-based
                oferenda_id = row[COL_ID] if len(row) > COL_ID else f"linha-{i}"
                print(f"  ✓ Expirada: {oferenda_id} | tipo: {row[COL_TIPO]} | expirou: {expira_str}")
                expiradas += 1

        except Exception as e:
            print(f"  ⚠️  Erro na linha {i}: {e}")
            erros += 1

    print(f"\n📊 Resultado: {expiradas} expiradas | {erros} erros")

# ─── RECALCULAR NOTAS DOS PRATICANTES ────────────────────────
def recalcular_notas(sh):
    """
    Lê todas as avaliações e recalcula nota_media e total_votos
    para cada praticante.
    """
    try:
        ws_aval = sh.worksheet("avaliacoes")
        ws_prat = sh.worksheet("praticantes")
    except gspread.exceptions.WorksheetNotFound:
        print("ℹ️  Abas de avaliação/praticantes não encontradas. Pulando.")
        return

    avals = ws_aval.get_all_records()
    if not avals:
        print("ℹ️  Nenhuma avaliação registrada.")
        return

    # Agrupar notas por praticante
    notas_por_praticante: dict[str, list[float]] = {}
    for av in avals:
        pid  = str(av.get("id_praticante", "")).strip()
        nota = av.get("nota", "")
        if pid and nota:
            try:
                notas_por_praticante.setdefault(pid, []).append(float(nota))
            except (ValueError, TypeError):
                pass

    if not notas_por_praticante:
        print("ℹ️  Nenhuma nota válida encontrada.")
        return

    # Atualizar praticantes
    praticantes = ws_prat.get_all_values()
    atualizados = 0

    for i, row in enumerate(praticantes[1:], start=2):
        if not row:
            continue
        pid = row[PRAT_ID].strip()
        if pid in notas_por_praticante:
            notas  = notas_por_praticante[pid]
            media  = round(sum(notas) / len(notas), 2)
            total  = len(notas)
            ws_prat.update_cell(i, PRAT_NOTA_MEDIA + 1, media)
            ws_prat.update_cell(i, PRAT_TOTAL_VOTOS + 1, total)
            print(f"  ★ Praticante {pid[:8]}... → nota: {media} ({total} votos)")
            atualizados += 1

    print(f"\n📊 {atualizados} praticantes atualizados.")

# ─── LOG EXECUÇÃO ────────────────────────────────────────────
def registrar_log(sh):
    """Registra a execução para rastreabilidade."""
    try:
        ws = sh.worksheet("log_execucoes")
    except gspread.exceptions.WorksheetNotFound:
        return  # aba opcional, não obrigatória

    ws.append_row([
        datetime.now(timezone.utc).isoformat(),
        "expire_cron",
        "ok"
    ])

# ─── MAIN ────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 50)
    print("OFERENDA DIGITAL — Cron de Manutenção")
    print(f"Início: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 50)

    sh = autenticar()
    print("✅ Autenticado no Google Sheets\n")

    print("── Expirando oferendas ──────────────────────────")
    expirar_oferendas(sh)

    print("\n── Recalculando notas dos praticantes ───────────")
    recalcular_notas(sh)

    print("\n── Registrando log ──────────────────────────────")
    registrar_log(sh)

    print("\n✅ Concluído.")
