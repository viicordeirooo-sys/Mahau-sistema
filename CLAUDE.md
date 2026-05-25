# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Mahau is a financial management system (in Brazilian Portuguese) for a bar / event venue. The entire application is a **single file: `index.html`** (~2150 lines) — HTML, CSS, and JavaScript inline. There is no build system, no package manager, no tests, and no source tree to navigate.

- **Run it:** open `index.html` in a browser, or serve the directory statically (e.g. `python -m http.server`). All UI text and domain terms are in Portuguese.
- **Dependencies** are loaded from CDNs in the `<head>` (lines 7-9): Firebase 10.12.0 *compat* SDK (`firebase-app-compat`, `firebase-firestore-compat`) and SheetJS `xlsx` 0.18.5. There is no local `node_modules`.
- **Persistence** is Firebase Firestore. The config is hardcoded at `index.html:208-215` (project `mahau-sistema`). There is **no authentication** — the app assumes open Firestore rules (`allow read, write: if true`). If a write fails, the app surfaces this in an alert.

## Architecture

Vanilla-JS single-page app with a hand-rolled render loop. No framework, no reactivity library — UI is rebuilt by assigning HTML strings to `innerHTML`.

- **Global state `S`** (`index.html:272`) holds every collection as an array (`produtos`, `fichas`, `compras`, `eventos`, `evento_vendas`, `custos`, `inventarios`), plus `config`, the current `page`, and `mesSel` (selected month filter).
- **`FS`** (`index.html:219`) is the thin Firestore wrapper: `save`, `del`, `setDoc`, `listen`. `save` auto-assigns the Firestore doc id back into the document's `id` field.
- **`init()`** (`index.html:2135`) registers an `onSnapshot` listener per collection. Every snapshot overwrites the matching `S.*` array and calls `render()` — so the UI is always driven by live Firestore data; **never mutate `S.*` arrays directly and expect persistence**, always go through `FS`.
- **`render()`** (`index.html:467`) is the central dispatcher: it redraws the month bar and sidebar, then calls the one `render<Page>()` function for `S.page`. Each page is a `renderX()` function that builds a string and `set()`s it into a `<div id="p-...">`. Navigation is `go(id)` driven by the `PAGES` array (`index.html:426`).
- **Event handlers are inline `onclick=` attributes** calling global functions (e.g. `saveProd()`, `addVenda(eid)`, `FS.del(...)`). Because the DOM is regenerated on every render, there are no persistent listeners to manage — add behavior as inline handlers + a global function.
- **Month filtering:** most views filter by `S.mesSel` via the `noMes(dateStr)` helper (`index.html:311`). `null` means "all months". When adding aggregations, respect this filter.

## Core domain calculations (`index.html:358-423`)

These functions encode the business logic and require reading together:

- `estoqueAtual(pid)` — current stock of a product, in whole units. Starts from `estoque_inicial`, adds purchases, and subtracts consumption from event sales. **Recipe-aware:** a `ficha` (recipe) sale deducts each ingredient's `quantidade_ml` from the underlying products; a direct `produto` sale deducts full units. All math is done in **ml internally** then divided by `capacidade_ml`.
- `cmvEvento(eid)` — returns `{cmv, rec_bar}` (cost of goods sold + bar revenue) for an event, expanding recipes to ingredient cost.
- `calcEv(e)` — full per-event P&L: `receita = bar + entrada`, then subtracts CMV, direct event costs (`dj + seguranca + staff + outros`), and `rateio()`. Returns margins/percentages used across Dashboard, CMV, and Fechamento pages.
- `rateio()` — allocates monthly fixed costs (`custos`) across events by dividing the month's total by `config.datasNoMes` (number of event days/month, settable in the UI).

## Firestore data model

Field names are set in the `save*` functions; match them exactly when adding fields.

- **produtos** (`saveProd` :639): `nome, categoria, unidade, capacidade_ml, preco_compra, preco_venda, estoque_min, estoque_inicial`
- **fichas** (recipes, `saveFicha` :840): `nome, categoria, preco_venda, ingredientes:[{produto_id, quantidade_ml}]`
- **compras** (purchases, `saveCp` :1054): `produto_id, qtd, total, data`
- **eventos** (`saveEv` :1278): `data, nome, publico, vips, entrada, dj, seguranca, staff, outros` (+ `bar`, `origem` when imported)
- **evento_vendas** (event sales :1271): `evento_id, tipo` (`"produto"|"ficha"|"manual"`)`, item_id, qtd_vendida, qtd_cortesia, valor_unit, valor_total` (+ `nome_zigpay, cat_zigpay` when imported)
- **custos** (monthly fixed costs :1356): `nome, valor, mes` (`mes` = `"YYYY-MM"`)
- **inventarios** (weekly counts :1567): `semana, data, contagens`
- **config/settings** (singleton doc): `datasNoMes`

## ZigPay import (`index.html:1936-2042`)

The app imports the venue's POS (ZigPay) Excel export to auto-create an event and its sales. `parseZigFile` reads the sheet with SheetJS and buckets each line by category: `ZIG_BAR_CATS` → bar revenue, `ZIG_ENTRADA_CATS` → service fees (entrada), `ZIG_SKIP` keywords → discarded. Imported sale items are **fuzzy-matched by name** to existing `produtos`/`fichas` (falling back to `tipo:"manual"` when unmatched). When changing product names or categories, be aware this matching is substring-based and case-insensitive.

`exportarExcel()` (:1676) does the reverse — builds a multi-sheet `.xlsx` (Eventos, CMV Produtos, Compras, Estoque) for the selected period.

## Conventions

- **Destructive deletes require typed confirmation:** `confirmarLimpar(cb)` (:231) shows a modal demanding the user type `LIMPAR` before running `cb`. Wrap any permanent-deletion action in it, matching existing `onclick="confirmarLimpar(()=>FS.del(...))"` usage.
- **Currency/percent formatting** helpers: `R` (BRL, no decimals), `Rf` (BRL with decimals), `P` (percent). Read with `nv(id)` (number) / `sv(id)` (string) and write with `set(id, html)`.
- **Seeding:** `seedIfEmpty()` / the Produtos-page button batch-creates the `ZIGPAY_PRODUTOS` catalog; `seedCombos()` generates combo recipe `fichas`. These are manual, button-triggered actions.
