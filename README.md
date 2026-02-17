# MCP Minutes Gateway

## Ueberblick
Ein MCP-Server (HTTP-only) mit folgenden Tools:

- `minutes_render_and_upload_docx`: Validiert die Minutes, rendert die DOCX-Datei und laedt sie in den OUTPUT-Ordner hoch.
- `list_tools`: Listet alle verfuegbaren Tools und Schema-Hinweise auf.
- `tool_help`: Zeigt Schema-Hinweise und Beispiele fuer ein bestimmtes Tool (Suche nach Name).

## Primary Workflow (Claude Desktop)
1. MCP-Server starten:
   - `npm run dev`
   - Alternativ: `node --env-file=.env.graph --import tsx src/index.ts`
2. In Claude Desktop die Transcript-Datei (.txt/.md) in den Chat ziehen.
3. User schreibt: `Erstelle Meeting Minutes als DOCX`.
4. Tool `minutes_render_and_upload_docx` wird aufgerufen.
5. Antwort enthaelt einen klickbaren Download-Link zur DOCX (lokal vom Server gehostet).
6. DOCX wird anschliessend manuell hochgeladen (wo auch immer).

Wichtig: Das Tool akzeptiert nur strukturierte Minutes (der LLM extrahiert diese aus dem Chat-Kontext).

## Local Smoke Test
Ziel: Lokaler Test des Primary-Flows mit HTTP-Download-Link.

```bash
set MCP_HTTP_HOST=127.0.0.1
set MCP_HTTP_PORT=3000
set DOCX_TEMPLATE_PATH=.\templates\minutes_template.docx
npm run dev
```

Dann in Claude Desktop:
1. Transcript-Datei in den Chat ziehen.
2. Prompt: `Erstelle Minutes als DOCX`.
3. Ergebnis: Klickbarer Download-Link (Format `http://127.0.0.1:3000/download/<id>`).

## Contract Test
Client-robuster E2E-Test fuer den Primary Workflow:

```bash
npm run test:contract
```

## Umgebungsvariablen (Environment)
Der Server liest ausschliesslich `process.env`. Fuer Local Dev kannst du `.env`-Dateien per
`node --env-file=...` laden (siehe "Ausfuehren"). In Prod/BTP/CI nutzt du Plattform-Env;
`.env`-Dateien sind nur fuer lokale Entwicklung.

Verwenden Sie die Datei `.env.graph` als Vorlage.

### Erforderliche Variablen
| Variable | Beschreibung |
| :--- | :--- |
| `MCP_HTTP_PORT` | HTTP-Port fuer MCP |
| `MCP_HTTP_HOST` | Hostbindung, z. B. `0.0.0.0` |
| `MCP_ALLOWED_HOSTS` | (Optional) Kommagetrennte Host-Allowlist fuer DNS-Rebinding-Schutz |
| `MCP_ALLOWED_ORIGINS` | (Optional) Kommagetrennte Origin-Allowlist (z. B. AppRouter/Frontend) |
| `DOCX_TEMPLATE_PATH` | Pfad zur Vorlage (z. B. `templates\\minutes_template.docx`) |
| `OUTPUT_FILENAME_PATTERN` | (Optional) Muster fuer den Dateinamen |
| `LOG_LEVEL` | (Optional) Detailgrad der Protokollierung |
| `ALLOW_X_USER_TOKEN` | (Optional) `true` nur fuer lokale Tests; in Production deaktiviert |

## Ausfuehren
Verwenden Sie den folgenden Befehl, um den Server im Entwicklungsmodus zu starten:

```bash
npm run dev
```

Der MCP-Server laeuft ausschliesslich ueber HTTP; `MCP_HTTP_PORT` ist Pflicht.

### Deployment-Hinweis (AppRouter)
Der MCP-Server ist fuer den Betrieb **hinter einem AppRouter/Reverse-Proxy** gedacht und soll nicht direkt oeffentlich
exponiert werden. Fuer nicht-lokale Hosts muss eine Allowlist gesetzt werden:

- `MCP_ALLOWED_HOSTS` und/oder `MCP_ALLOWED_ORIGINS` (kommagetrennt)
- Ohne Allowlist startet der Server bei nicht-lokaler Bindung nicht
- `MCP_HTTP_HOST=0.0.0.0` nur verwenden, wenn der Server hinter AppRouter/Proxy haengt **und** die Allowlist gesetzt ist
- In Production sollte `NODE_ENV=production` gesetzt sein (damit `ALLOW_X_USER_TOKEN` hart gesperrt ist)

## HTTP Smoke Test
Der minimale E2E-Check fuer HTTP MCP ist in `scripts/http_smoke_test.ts`.
Er faehrt `initialize`, `tools/list` und `tools/call` (tool_help) ueber den Streamable HTTP Transport.

Hinweis: Dieser Test ist optional und nicht Teil des Primary Workflows.

So startest du den Test:

```bash
set MCP_HTTP_HOST=127.0.0.1
set MCP_HTTP_PORT=3000
npm run dev
tsx scripts/http_smoke_test.ts
```

Hinweis: Bei `MCP_HTTP_HOST=127.0.0.1` oder `localhost` ist DNS-Rebinding-Protection aktiv
(allowedHosts/allowedOrigins sind gesetzt).
