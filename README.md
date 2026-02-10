# MCP SharePoint Minutes Gateway

## Überblick
Ein MCP-Server (stdio oder HTTP) mit folgenden Tools:

* **`sp_list_protocols`**: Listet Dateien im freigegebenen **INPUT**-Ordner auf.
* **`sp_download_protocol`**: Lädt eine Datei anhand der ID herunter (mit optionaler Textextraktion).
* **`minutes_render_and_upload_docx`**: Validiert das Protokoll, rendert die DOCX-Datei und lädt sie in den **OUTPUT**-Ordner hoch.
* **`list_tools`**: Listet alle verfügbaren Tools und Schema-Hinweise auf.
* **`tool_help`**: Zeigt Schema-Hinweise und Beispiele für ein bestimmtes Tool (Suche nach Name).

## Umgebungsvariablen (Environment)
Der Server liest **ausschließlich** `process.env`. Es ist kein `dotenv`-Loader im Code integriert.

Verwenden Sie die Dateien `.env.graph` und `.env.local` als Vorlagen und laden Sie diese über Ihre Shell oder einen entsprechenden Wrapper.

### Erforderliche Variablen für den Graph-Modus
| Variable | Beschreibung |
| :--- | :--- |
| `MODE` | Muss auf `graph` gesetzt sein |
| `SCOPE_MODE` | `per_user` (empfohlen) oder `fixed` |
| `GRAPH_AUTH_MODE` | `delegated` (fÃ¼r per_user) oder `app` |
| `BASE_FOLDER_NAME` | Oberordner, z. B. `LillyMinutes` |
| `DESTINATION_NAME` | Name der BTP Destination (OAuth2UserTokenExchange) |
| `MCP_HTTP_PORT` | HTTP-Port fÃ¼r MCP (per_user erfordert HTTP) |
| `MCP_HTTP_HOST` | Hostbindung, z. B. `0.0.0.0` |
| `MCP_ALLOWED_HOSTS` | (Optional) Kommagetrennte Host-Allowlist fÃ¼r DNS-Rebinding-Schutz |
| `MCP_ALLOWED_ORIGINS` | (Optional) Kommagetrennte Origin-Allowlist (z. B. AppRouter/Frontend) |
| `TENANT_ID` | Microsoft Entra (Azure AD) Tenant ID |
| `CLIENT_ID` | Application (Client) ID |
| `CLIENT_SECRET` | Client Secret der Anwendung |
| `SITE_ID` | SharePoint Site ID |
| `DRIVE_ID` | ID des Document Library Drive |
| `INPUT_FOLDER_ID` | Nur bei `SCOPE_MODE=fixed` |
| `OUTPUT_FOLDER_ID` | Nur bei `SCOPE_MODE=fixed` |
| `DOCX_TEMPLATE_PATH` | Pfad zur Vorlage (z. B. `templates\minutes_template.docx`) |
| `OUTPUT_FILENAME_PATTERN` | (Optional) Muster für den Dateinamen |
| `LOG_LEVEL` | (Optional) Detailgrad der Protokollierung |
| `MAX_DOWNLOAD_BYTES` | (Optional) Limit für Downloads (Standard: 10.000.000) |
| `ALLOW_X_USER_TOKEN` | (Optional) `true` nur für lokale Tests; in Production deaktiviert |
| `XSUAA_JWT` | (Optional) JWT für lokale Tests ohne HTTP |

### Erforderliche Variablen für den lokalen Modus
| Variable | Beschreibung |
| :--- | :--- |
| `MODE` | Muss auf `local` gesetzt sein |
| `LOCAL_INPUT_DIR` | Pfad zum lokalen Eingangsverzeichnis |
| `LOCAL_OUTPUT_DIR` | Pfad zum lokalen Ausgangsverzeichnis |
| `DOCX_TEMPLATE_PATH` | Pfad zur DOCX-Vorlage |
| `OUTPUT_FILENAME_PATTERN` | (Optional) Benennungsschema |
| `LOG_LEVEL` | (Optional) Logging-Level |
| `MAX_DOWNLOAD_BYTES` | (Optional) Maximalgröße der Downloads |

## Ausführen
Verwenden Sie den folgenden Befehl, um den Server im Entwicklungsmodus zu starten:

```bash
npm run dev
```

Für per-user Scope (delegated) muss der MCP-Server über HTTP erreichbar sein:

```bash
MCP_HTTP_PORT=3000 npm run dev
```

### Deployment-Hinweis (AppRouter)
Der MCP-Server ist fÃ¼r den Betrieb **hinter einem AppRouter/Reverse-Proxy** gedacht und soll nicht direkt Ã¶ffentlich
exponiert werden. FÃ¼r nicht-lokale Hosts muss eine Allowlist gesetzt werden:

* `MCP_ALLOWED_HOSTS` und/oder `MCP_ALLOWED_ORIGINS` (kommagetrennt)
* Ohne Allowlist startet der Server bei nicht-lokaler Bindung nicht
* `MCP_HTTP_HOST=0.0.0.0` nur verwenden, wenn der Server hinter AppRouter/Proxy hÃ¤ngt **und** die Allowlist gesetzt ist
* In Production sollte `NODE_ENV=production` gesetzt sein (damit `ALLOW_X_USER_TOKEN` hart gesperrt ist)

## HTTP Smoke Test (per_user)
Der minimale E2E-Check für HTTP Auth-Propagation ist in `scripts/http_smoke_test.ts`.
Er fährt `initialize`, `tools/list` und `tools/call` (sp_list_protocols) über den Streamable HTTP Transport
und validiert, dass der Bearer-Token pro Request ankommt (siehe Server-Log).

So startest du den Test:

```bash
# Wichtig: kein XSUAA_JWT setzen, sonst ist es kein echtes E2E
set XSUAA_JWT=
set MCP_HTTP_HOST=127.0.0.1
set MCP_HTTP_PORT=3000
set MCP_BEARER_TOKEN=eyJ...   # User JWT / SSO Token
npm run dev
tsx scripts/http_smoke_test.ts
```

Erwartet im Server-Log:
* `authSource=header` (nicht xsuaa_jwt)
* `userKey` ist gesetzt
* `inputFolderId` und `outputFolderId` sind gesetzt
* Prefixe `basePrefix`, `userPrefix`, `inputPrefix`, `outputPrefix` werden geloggt

Hinweise:
* `Authorization: Bearer <token>` hat Vorrang. Ein Fallback auf `x-user-token` passiert nur, wenn
  `ALLOW_X_USER_TOKEN=true` gesetzt ist.
* Bei `MCP_HTTP_HOST=127.0.0.1` oder `localhost` ist DNS-Rebinding-Protection aktiv
  (allowedHosts/allowedOrigins sind gesetzt).
