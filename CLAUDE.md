# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Mahau is a financial management system (in Brazilian Portuguese) for a bar / event venue. The entire application is a **single file: `index.html`** (~2150 lines) — HTML, CSS, and JavaScript inline. There is no build system, no package manager, no tests, and no source tree to navigate.

- **Run it:** open `index.html` in a browser, or serve the directory statically (e.g. `python -m http.server`). All UI text and domain terms are in Portuguese.
- **Dependencies** are loaded from CDNs in the `<head>` (lines 7-9): Firebase 10.12.0 *compat* SDK (`firebase-app-compat`, `firebase-firestore-compat`) and SheetJS `xlsx` 0.18.5. There is no local `node_modules`.
- **Persistence** is Firebase Firestore. The config is hardcoded at `index.html:208-215` (project `mahau-sistema`). **Authentication:** Firebase Auth (email/senha) — the whole app sits behind a login screen (`doLogin`/`onAuthStateChanged` → `showApp`/`showLogin`, `bindData`/`unbindData` attach/detach the listeners). There's effectively a single user, so **logado = admin**. Firestore rules require an authenticated user (`allow read, write: if request.auth != null`) and live in `firestore.rules`, **applied manually via the Firebase console** (not auto-deployed — see that file's header); per-org `orgId` isolation is a future phase. If a write fails, the app surfaces the error via toast.

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

- `estoqueAtual(pid)` (via `Domain.estoqueIndex`) — stock in whole units = **last physical count (weekly or monthly) + purchases − Zig sale baixas, since the count**, compared by `createdAt` (server timestamp). Never-counted product → fallback `estoque_inicial + all purchases − all baixas`. The **sale baixas** come from the per-event Zig import (`eventos[].zig_baixas`, see below); before Sprint 3 stock had no sales dependency. The weekly inventory uses this as "Teórico"; with baixas subtracted, Desvio = Físico − Teórico now reads as **losses/shrinkage** (sales already netted out) rather than consumption+losses.
- `calcEv(e)` (in `domain.js`) — per-night P&L, **no CMV**: `Bar Líquido = bar_bruto − caixinha`; `Receita Total Casa = Bar Líquido + entrada(porta) + caixinha×(pct_casa/100)`; `Resultado = Receita − custos diretos − rateio`. The staff tip share (`caixinha − caixinha casa`) is informational.
- `cmvRealMensal()` + `Domain.valorInventario` — the **CMV is real and monthly** (not per-event): `Estoque Inicial(mês−1) + Compras(mês) − Estoque Final(mês)`, valued from the monthly inventory counts. Rendered by `blocoCmvReal()` in Fechamento and the CMV page.
- `rateio()` — allocates monthly fixed costs (`custos`) across events: month total ÷ `config.datasNoMes`.

## Firestore data model

Field names are set in the `save*` functions; match them exactly when adding fields.

- **produtos** (`saveProd` :639): `nome, categoria, unidade, capacidade_ml, preco_compra, preco_venda, estoque_min, estoque_inicial`. Cadastro/atualização em massa via **Estoque → 📋 Importar planilha de produtos** (`importCatalogoFile`/`salvarCatalogo`): upsert por nome a partir do XLSX de produtos (`parseEstoqueRows`+`casarEstoque`), que **redefine `estoque_inicial` em TODOS** (novos e existentes — a planilha é o "ponto zero" do estoque) e preserva `preco_venda` via merge. **Não** cria semana/snapshot de conciliação. (Também `+ Novo Produto` / Editar em Massa manualmente.)
- **fichas** (recipes, `saveFicha` :840): `nome, categoria, preco_venda, ingredientes:[{produto_id, quantidade_ml}]`
- **compras** (purchases, `saveCp` :1054): `produto_id, qtd, total, data`
- **eventos** (`saveEv`): `data, mes, nome, publico, vips, bar_bruto, entrada` (porta/cover)`, caixinha, pct_casa` (% da caixinha que fica com a casa)`, dj, seguranca, staff, outros`. Import Zig (Sprint 3, `aplicarBaixaEvento`) acrescenta `zig_baixas` (`{produto_id: unidades}` — o que foi descontado do estoque), `zig_importado_em`, `zig_arquivo_nome`, `zig_total_itens` (via `FS.save` merge, sem mexer no faturamento).
- **custos** (monthly fixed costs, `addCusto`): `nome, valor, mes` (`mes` = `"YYYY-MM"`)
- **inventarios** (weekly counts, `salvarInventario`): `semana, mes, data, contagens` (`contagens` = `{produtoId: qtdFísica}`) — detecção de desvio/quebra
- **inventarios_mensais** (`salvarInventarioMensal`): `mes, data, contagens` — base do CMV Real (uma contagem por mês)
- *(Removidos no refactor de Eventos: `evento_vendas`, vendas por produto, import ZigPay.)*
- **config/settings** (singleton doc): `datasNoMes`

## Excel export

`exportarExcel()` builds a multi-sheet `.xlsx` (Eventos, Compras, Estoque) for the selected period, from the "⬇ Exportar Excel" button on Fechamento.

*(The former ZigPay POS import — `parseZigFile`/`importZigPay`/`ZIG_*` — was removed in the events refactor, since events no longer track per-product sales.)*

## Conciliação de estoque (módulo)

Conciliação semanal que cruza dados de venda da Zig com a contagem física, **separado** do evento financeiro `eventos`. Página **"🔄 Conciliação"** (`renderConciliacao`) com sub-abas (`S.concilTab`): Semanas · Estoque · Saída Zig · Cortesias · Estornos · Mapeamento · Resultado. Uma semana ativa (`S.concilSemanaSel`) é o contexto dos imports; usa o período da semana, **não** o filtro de mês global.

- **Coleções próprias** (no `bindData`/Lixeira, fora do `STOCK` — não afetam `estoqueAtual`): `semanas_conciliacao` (`{periodo_inicio, periodo_fim, status}`), `estoques` (`{semana_id, tipo:'antes'|'depois', data_contagem, produtos:[...]}` — contagem física por semana, **separada** de `inventarios`/`inventarios_mensais`; a aba 📦 Estoque da Conciliação **só grava esse snapshot** — cadastrar/atualizar o catálogo de produtos é na página Estoque → Importar planilha, ver acima; se um produto do XLSX não estiver no catálogo, avisa mas salva o snapshot mesmo assim), `vendas_zig` (`{semana_id, periodo_inicio, periodo_fim, itens:[{sku,produto,quantidade}]}` — a **Saída Geral consolidada da semana** da Zig: um arquivo por semana, **substitui** o anterior; **NÃO** é o evento financeiro, e não tem montáveis nem valor), `cortesias_semana` (`{semana_id, periodo_*, itens:[{promoter, produto, categoria, valor_brl, valor_outro_periodo}]}` — Bonificação por produto, 1/semana), `estornos_semana` (`{semana_id, periodo_*, itens:[{data, produto, categoria, tipo, motivo, quantidade, valor}]}` — só `tipo:"Estornado"` devolve ao estoque; `"Cancelado"` é informativo), `mapeamento_zig` (`{sku_zig, nome_zig, tipo:'direto'|'combo'|'montavel'|'ignorar', regras:[{produto_id, quantidade_baixa, unidade}], preco_zig, mixer_produto_id, mixer_nome, garrafa_qtd, redbull_qtd}` — `regras` aceita **N entradas** em direto/montável, 1 por ingrediente (ex: Long Island = vodka+gin+tequila+rum+cointreau); o form de Mapeamento tem "+ Adicionar ingrediente"/✕ por linha, sem produto duplicado. `preco_zig` converte cortesia R$→qtd; no combo, `mixer_produto_id`×`redbull_qtd` é o mixer que baixa), `conciliacoes` (`{semana_id, periodo_*, gerado_em, resultados:[...], total_falta, total_sobra, contagem, meta}` — resultado salvo, 1/semana, substitui).
- **Parsers puros em `domain.js`** (XLSX via SheetJS, header detectado dinamicamente): `_norm`, `_detectHeader`, `parseEstoqueRows` + `casarEstoque` (estoque da funcionária → casa por nome com `produtos`, flags novo/custo±30%/negativo), `parseSaidaGeral` (Saída Geral da Zig) + `extrairPeriodoZig`, `parseCortesias`/`parseEstornos` (+ `extrairPeriodoCortesias`/`Estornos`, `_numBR` R$ US-format, `_dataUS` M/D/YY→ISO). Validados contra arquivos reais.
- **Motor (`domain.js`):** `resolverBaixa(mapping, qtd, prodById)` traduz "produto Zig + qtd" → `[{produto_id, unidades}]` (compartilhado por venda/cortesia/estorno; direto/montável **itera todas as `regras[]`** — 1 baixa por ingrediente, com ml→garrafa via `capacidade_ml` por regra; **combo baixa SÓ o mixer** — a garrafa vem da linha montável separada, evitando a **dupla contagem nativa** da Saída Geral). `conciliar({...})` aplica `esperado = antes + compras − venda − cortesia + estorno` (Saída tratada como **bruta**: estorno só "Estornado" volta; cortesia = `round(valor_brl/preco_zig)`; compras = coleção `compras` **existente** filtrada por `data ∈ período`), com status OK/FALTA/SOBRA/SEM FICHA, valor R$ e `meta` do que ficou de fora. `PRODUTOS_SEM_FICHA` (`Gin Mahau`, `Kawai - vodka`, `Gelo De Coco`) saem do cálculo. Cortesias/estornos casam por **nome** (`nome_zig`), pois não têm SKU.
- **Status:** **Sprints 1, 2 e 3 prontos.** Export do Resultado: PDF via `window.print()` numa view estilizada (sem lib) e resumo p/ WhatsApp via clipboard. **Aberto:** fichas técnicas dos drinks autorais, histórico de conciliações, alertas.
- Plano completo em `PLANO_TECNICO_CONCILIACAO_MAHAU.md` e planilhas reais ficam na raiz, **gitignored** (`*.xlsx`) — o Vercel serve a raiz publicamente.

## Import de produtos vendidos da Zig por evento (Sprint 3 — baixa de estoque)

Botão **"📥 Importar produtos vendidos da Zig"** dentro do **evento financeiro** (`importVendidosHTML`, aparece com um evento selecionado em `renderEventos`) — distinto da Conciliação semanal. Importa o XLSX `total-produtos-vendidos` da Zig (formato **POR DIA**, 2 abas: *Vendidos* + *Montáveis*) e **baixa o `estoqueAtual`** via `mapeamento_zig`; **não** toca em faturamento/porta/caixinha (seguem manuais). É o único Zig que escreve estoque; reusa o dicionário `mapeamento_zig` da Conciliação.

- **Parsers puros (`domain.js`):** `parseProdutosVendidos` (SKU, Nome, Categoria, `Montável` TRUE/FALSE, Quantidade, Valor unitário/total) e `parseMontaveis` (SKU pai, Item Montável, Quantidade) — header dinâmico; `extrairDataZigEvento` (título "…no dia DD/MM/YYYY"). ⚠️ Estrutura **diferente** da Saída Geral semanal: a garrafa/mixers de um combo estão **só na aba Montáveis** (não como linha top-level).
- **Motor (`domain.js`) `baixaEvento({vendidos, montaveis, mapeamentos, produtos})`** → `{baixas:{pid:un}, detalhe, naoMapeados:{skus,nomes}, total_itens, total_valor}`, reusando `resolverBaixa`: Vendidos `Mont=FALSE` baixa por **SKU**; `Mont=TRUE` é **pulado** (só container, anti-dupla); Montáveis baixa o item real por **nome** (`mapByNome`). Modifiers (ponto da carne, "sem limão") ficam sem mapa → não baixam.
- **Estoque:** `Domain.estoqueIndex(produtos, compras, contagens, baixas)` ganhou o termo `baixasSince` (subtrai as baixas de venda com a mesma regra de timing das compras). O wrapper `estoqueIndex()` monta `baixas` de `S.eventos[].zig_baixas` (timing por `createdAt` do evento); `STOCK` inclui `"eventos"`.
- **Aplicar/substituir/reverter (`aplicarBaixaEvento`):** grava o agregado em `eventos[].zig_baixas`. Reimportar **substitui** (o índice deriva sempre do `zig_baixas` atual → sem dupla baixa). Soft-deletar o evento **reverte** a baixa (sai de `S.eventos`). Botão "Remover baixa" (`removerBaixaEvento`) zera `zig_baixas`. Bônus: "Preencher preços Zig faltantes" (`preencherPrecosZig`) preenche `preco_zig` dos mapeamentos por SKU usando o `valor_unitario` do arquivo.

## Conventions

- **Deletes are soft by default:** the ✕ buttons call `softDel(col,id)` (simple confirm → `FS.del`, which sets `deletedAt`). Listeners in `bindData` filter `deletedAt` out of `S[col]` and into `S._trash[col]`, so all calc/render automatically excludes soft-deleted docs. The **Lixeira** page (`renderLixeira`) restores (`FS.restore`, clears `deletedAt`) or permanently deletes. **Permanent deletion** (`FS.hardDel`) is the only thing still gated by the typed-`LIMPAR` modal `confirmarLimpar(cb)` (used in the Lixeira).
- **Currency/percent formatting** helpers: `R` (BRL, no decimals), `Rf` (BRL with decimals), `P` (percent). Read with `nv(id)` (number) / `sv(id)` (string) and write with `set(id, html)`.
- **Seeding:** `seedCombos()` (button on the Fichas page) generates the combo recipe `fichas`. Products are created manually (`+ Novo Produto` / Editar em Massa) ou em massa pelo XLSX em **Estoque → 📋 Importar planilha de produtos** (`salvarCatalogo`). The old product seed and the legacy **ZigPay** POS import (`parseZigFile`/`importZigPay`) were both removed in the events refactor — not to be confused with the current per-event Zig import (Sprint 3, `importVendidosHTML`/`aplicarBaixaEvento`), which only baixa stock and never touches revenue.
