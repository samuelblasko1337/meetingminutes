# MCP SharePoint Minutes Gateway

## Überblick
Ein MCP-Server (stdio) mit folgenden Tools:

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
| `TENANT_ID` | Microsoft Entra (Azure AD) Tenant ID |
| `CLIENT_ID` | Application (Client) ID |
| `CLIENT_SECRET` | Client Secret der Anwendung |
| `SITE_ID` | SharePoint Site ID |
| `DRIVE_ID` | ID des Document Library Drive |
| `INPUT_FOLDER_ID` | ID des Quellordners für Protokolle |
| `OUTPUT_FOLDER_ID` | ID des Zielordners für fertige DOCX-Dateien |
| `DOCX_TEMPLATE_PATH` | Pfad zur Vorlage (z. B. `templates\minutes_template.docx`) |
| `OUTPUT_FILENAME_PATTERN` | (Optional) Muster für den Dateinamen |
| `LOG_LEVEL` | (Optional) Detailgrad der Protokollierung |
| `MAX_DOWNLOAD_BYTES` | (Optional) Limit für Downloads (Standard: 10.000.000) |

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
