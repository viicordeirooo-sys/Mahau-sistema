# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Mahau is a financial management system (in Brazilian Portuguese) for a bar / event venue. The entire application is a **single file: `index.html`** (~2150 lines) — HTML, CSS, and JavaScript inline. There is no build system, no package manager, no tests, and no source tree to navigate.

- **Run it:** open `index.html` in a browser, or serve the directory statically (e.g. `python -m http.server`). All UI text and domain terms are in Portuguese.
- **Dependencies** are loaded from CDNs in the `<head>` (lines 7-9): Firebase 10.12.0 *compat* SDK (`firebase-app-compat`, `firebase-firestore-compat`) and SheetJS `xlsx` 0.18.5. There is no local `node_modules`.
- **Persistence** is Firebase Firestore. The config is hardcoded at `index.html:208-215` (project `mahau-sistema`). There is **no authentication** — the app assumes open Firestore rules (`allow read, write: if true`). If a write fails, the app surfaces this in an alert.

## Architecture

Vanilla-JS single-page app with a hand-rolled render loop. No framework, no reactivity library — UI is rebuilt by assigning HTML strings to `innerHTML`.

- **Global state `S`** (`index.html:272`) holds every collection as an array (`produtos`, `fichas`, `compras`, `eventos`, `custos`, `inventarios`, `inventarios_mensais`), plus `config`, the current `page`, `mesSel` (selected month filter), and `_trash` (soft-deleted docs).
- **`FS`** (`index.html:219`) is the thin Firestore wrapper: `save`, `del`, `setDoc`, `listen`. `save` auto-assigns the Firestore doc id back into the document's `id` field.
- **`init()`** (`index.html:2135`) registers an `onSnapshot` listener per collection. Every snapshot overwrites the matching `S.*` array and calls `render()` — so the UI is always driven by live Firestore data; **never mutate `S.*` arrays directly and expect persistence**, always go through `FS`.
- **`render()`** (`index.html:467`) is the central dispatcher: it redraws the month bar and sidebar, then calls the one `render<Page>()` function for `S.page`. Each page is a `renderX()` function that builds a string and `set()`s it into a `<div id="p-...">`. Navigation is `go(id)` driven by the `PAGES` array (`index.html:426`).
- **Event handlers are inline `onclick=` attributes** calling global functions (e.g. `saveProd()`, `saveEv()`, `FS.del(...)`). Because the DOM is regenerated on every render, there are no persistent listeners to manage — add behavior as inline handlers + a global function.
- **Month filtering:** most views filter by `S.mesSel` via `noMes(dateStr)` (wrapper of `Domain.noMes`). `null` means "all months". Period-scoped docs (`eventos`, `compras`, `custos`, `inventarios`, `inventarios_mensais`) carry a denormalized `mes` (`"YYYY-MM"`); filter call sites pass `x.mes || x.data` so new docs filter by `mes` and legacy `"dd/mm"` docs fall back to the old behavior (visible only in "all months"). Dates are stored ISO (`YYYY-MM-DD`, `type="date"` inputs) and displayed via `fmtData` (→ `dd/mm/aaaa`; legacy strings pass through). When adding aggregations, respect this filter.

## Core domain calculations (`index.html:358-423`)

These functions encode the business logic and require reading together:

- `estoqueAtual(pid)` (via `Domain.estoqueIndex`) — stock in whole units = **last physical count (weekly or monthly) + purchases since it**, compared by `createdAt` (server timestamp). Never-counted product → fallback `estoque_inicial + all purchases`. No dependency on sales. The weekly inventory uses this as "Teórico"; Desvio = Físico − Teórico = consumption + losses.
- `calcEv(e)` (in `domain.js`) — per-night P&L, **no CMV**: `Bar Líquido = bar_bruto − caixinha`; `Receita Total Casa = Bar Líquido + entrada(porta) + caixinha×(pct_casa/100)`; `Resultado = Receita − custos diretos − rateio`. The staff tip share (`caixinha − caixinha casa`) is informational.
- `cmvRealMensal()` + `Domain.valorInventario` — the **CMV is real and monthly** (not per-event): `Estoque Inicial(mês−1) + Compras(mês) − Estoque Final(mês)`, valued from the monthly inventory counts. Rendered by `blocoCmvReal()` in Fechamento and the CMV page.
- `rateio()` — allocates monthly fixed costs (`custos`) across events: month total ÷ `config.datasNoMes`.

## Firestore data model

Field names are set in the `save*` functions; match them exactly when adding fields.

- **produtos** (`saveProd` :639): `nome, categoria, unidade, capacidade_ml, preco_compra, preco_venda, estoque_min, estoque_inicial`
- **fichas** (recipes, `saveFicha` :840): `nome, categoria, preco_venda, ingredientes:[{produto_id, quantidade_ml}]`
- **compras** (purchases, `saveCp` :1054): `produto_id, qtd, total, data`
- **eventos** (`saveEv`): `data, mes, nome, publico, vips, bar_bruto, entrada` (porta/cover)`, caixinha, pct_casa` (% da caixinha que fica com a casa)`, dj, seguranca, staff, outros`
- **custos** (monthly fixed costs, `addCusto`): `nome, valor, mes` (`mes` = `"YYYY-MM"`)
- **inventarios** (weekly counts, `salvarInventario`): `semana, mes, data, contagens` (`contagens` = `{produtoId: qtdFísica}`) — detecção de desvio/quebra
- **inventarios_mensais** (`salvarInventarioMensal`): `mes, data, contagens` — base do CMV Real (uma contagem por mês)
- *(Removidos no refactor de Eventos: `evento_vendas`, vendas por produto, import ZigPay.)*
- **config/settings** (singleton doc): `datasNoMes`

## Excel export

`exportarExcel()` builds a multi-sheet `.xlsx` (Eventos, Compras, Estoque) for the selected period, from the "⬇ Exportar Excel" button on Fechamento.

*(The former ZigPay POS import — `parseZigFile`/`importZigPay`/`ZIG_*` — was removed in the events refactor, since events no longer track per-product sales.)*

## Conciliação de estoque (módulo)

Conciliação semanal que cruza dados de venda da Zig com a contagem física, **separado** do evento financeiro `eventos`. Página **"🔄 Conciliação"** (`renderConciliacao`) com sub-abas (`S.concilTab`): Semanas · Estoque · Vendas Zig · Mapeamento. Uma semana ativa (`S.concilSemanaSel`) é o contexto dos imports; usa o período da semana, **não** o filtro de mês global.

- **Coleções próprias** (no `bindData`/Lixeira, fora do `STOCK` — não afetam `estoqueAtual`): `semanas_conciliacao` (`{periodo_inicio, periodo_fim, status}`), `estoques` (`{semana_id, tipo:'antes'|'depois', data_contagem, produtos:[...]}` — contagem física por semana, **separada** de `inventarios`/`inventarios_mensais`), `vendas_zig` (`{semana_id, periodo_inicio, periodo_fim, itens:[{sku,produto,quantidade}]}` — a **Saída Geral consolidada da semana** da Zig: um arquivo por semana, **substitui** o anterior; **NÃO** é o evento financeiro, e não tem montáveis nem valor), `mapeamento_zig` (`{sku_zig, nome_zig, tipo:'direto'|'combo'|'montavel'|'ignorar', regras:[...], garrafa_qtd, redbull_qtd}`). *(Sprint 2 adiciona `conciliacoes`.)*
- **Parsers puros em `domain.js`** (XLSX via SheetJS, header detectado dinamicamente): `_norm`, `_detectHeader`, `parseEstoqueRows` + `casarEstoque` (estoque da funcionária → casa por nome com `produtos`, flags novo/custo±30%/negativo), `parseSaidaGeral` (Saída Geral da Zig) + `extrairPeriodoZig`. Validados contra arquivos reais. **⚠️ A Saída Geral tem dupla contagem nativa** (combo pai + itens internos como linhas separadas) — o motor de conciliação (Sprint 2) precisa descontar via `mapeamento_zig`; comentário detalhado em `parseSaidaGeral`.
- **Status:** Sprint 1 pronto (imports de estoque/vendas + CRUD de mapeamento com detecção de SKU não mapeado). **Sprint 2 (pendente):** import de cortesias/estornos, registro de compras (⚠️ o plano define um `compras` que colide com a coleção `compras` existente que alimenta `estoqueAtual` — resolver nome/schema antes), e o **motor de conciliação** (`estoque_esperado = antes + compras − consumo`) + tela de resultado.
- Plano completo em `PLANO_TECNICO_CONCILIACAO_MAHAU.md` e planilhas reais ficam na raiz, **gitignored** (`*.xlsx`) — o Vercel serve a raiz publicamente.

## Conventions

- **Deletes are soft by default:** the ✕ buttons call `softDel(col,id)` (simple confirm → `FS.del`, which sets `deletedAt`). Listeners in `bindData` filter `deletedAt` out of `S[col]` and into `S._trash[col]`, so all calc/render automatically excludes soft-deleted docs. The **Lixeira** page (`renderLixeira`) restores (`FS.restore`, clears `deletedAt`) or permanently deletes. **Permanent deletion** (`FS.hardDel`) is the only thing still gated by the typed-`LIMPAR` modal `confirmarLimpar(cb)` (used in the Lixeira).
- **Currency/percent formatting** helpers: `R` (BRL, no decimals), `Rf` (BRL with decimals), `P` (percent). Read with `nv(id)` (number) / `sv(id)` (string) and write with `set(id, html)`.
- **Seeding:** `seedCombos()` (button on the Fichas page) generates the combo recipe `fichas`. Products are created manually (`+ Novo Produto` / Editar em Massa). The old product seed and the ZigPay sales import were both removed.
