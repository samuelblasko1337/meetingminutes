# MCP SharePoint Minutes Gateway

## Overview
MCP server (stdio) with tools:
- `sp_list_protocols`: list files in the allowlisted INPUT folder
- `sp_download_protocol`: download a file by id (optional text extraction)
- `minutes_render_and_upload_docx`: validate minutes, render DOCX, upload to OUTPUT folder
- `list_tools`: list available tools and schema hints
- `tool_help`: show schema hints and examples for a tool by name

## Environment
The server reads **only** `process.env`. There is no dotenv loader in code.

Use `.env.graph` and `.env.local` as templates and load them via your shell or wrapper.

Graph mode required variables:
- `MODE=graph`
- `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`
- `SITE_ID`, `DRIVE_ID`, `INPUT_FOLDER_ID`, `OUTPUT_FOLDER_ID`
- `DOCX_TEMPLATE_PATH` (default template is `templates\minutes_template.docx`)
- `OUTPUT_FILENAME_PATTERN` (optional)
- `LOG_LEVEL` (optional)
- `MAX_DOWNLOAD_BYTES` (optional, default 10000000)

Local mode required variables:
- `MODE=local`
- `LOCAL_INPUT_DIR`, `LOCAL_OUTPUT_DIR`
- `DOCX_TEMPLATE_PATH`
- `OUTPUT_FILENAME_PATTERN` (optional)
- `LOG_LEVEL` (optional)
- `MAX_DOWNLOAD_BYTES` (optional)

## Run
```bash
npm run dev
```
