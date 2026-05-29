# Validação de Fórmulas de Dinheiro — Mahau-sistema

**Data:** 29/05/2026

## Resumo

Auditoria analítica das 4 fórmulas de dinheiro do sistema. **Todas com lógica correta.** NENHUMA alteração de código foi aplicada (diferente do Posto) — só foram identificadas melhorias de robustez/clareza para fazer **depois do ponto-zero**. O teste numérico depende de dados reais (inventário mensal), que só existirão após a contagem física da próxima semana.

## Funções auditadas

### 1. `cmvRealMensal` — CMV real mensal via inventário

- **Fórmula:** Estoque Inicial (mês anterior) + Compras (mês) − Estoque Final (mês). Encadeado: o inventário de M−1 é o estoque inicial de M.
- **Veredito:** correta (fórmula contábil clássica de CMV).
- **Achados:**
  - Valora o estoque a preço **corrente** (`preco_compra` atual do catálogo), não histórico. Consequência: editar `preco_compra` muda o CMV de meses passados **retroativamente**. Vitor confirmou que altera preço com frequência → vira melhoria "congelar custo na data da contagem".
  - **Silenciamentos:** `preco_compra` ausente → R$ 0 sem aviso; `c.total` da compra ausente → R$ 0 sem aviso.
  - Guardas de fluxo sólidas (sem mês / sem inventário → mostra "pendente", não número falso). NaN não vaza.

### 2. `estoqueAtual` — saldo de estoque por produto

- **Fórmula:** se já houve contagem → última contagem + compras **depois** − baixas **depois**. Se nunca contado → `estoque_inicial` + todas as compras − todas as baixas. A contagem física é o marco zero.
- **Veredito:** correta, design elegante. Guardas de NaN sólidas.
- **Achados:**
  - **Risco de dupla contagem:** produto novo com `estoque_inicial` preenchido **e** compras lançadas soma os dois (infla o estoque). A janela fecha sozinha após a primeira contagem (`estoque_inicial` é bootstrap, só vale antes da 1ª contagem).
  - **Saldo negativo sem piso.** *Decisão do Vitor:* manter negativo **visível** (é alarme de erro de mapeamento/contagem; esconder em zero perderia informação). Melhoria: faixa visual de aviso, não travar em zero.

### 3. `rateio` — distribuição de custo fixo por evento

- **Fórmula:** `totalFixo(mês) / datasNoMes`. Divisão igualitária por um divisor **manual** (não proporcional, não automático).
- **Veredito:** correto. Divisão por zero blindada (`datasNoMes > 0 ? ... : 0`) + clamp 1–20 na UI.
- **Achados:**
  - O divisor é **manual** → Vitor precisa manter `datasNoMes` alinhado com o nº real de eventos do mês. A soma dos rateios só fecha com o total de custos fixos quando nº de eventos = `datasNoMes`.
  - Em "todos os meses" (`mesSel` = null), o número perde sentido.
  - *Decisão do Vitor:* manter manual (flexibilidade legítima) + melhoria: avisar quando `datasNoMes` != nº real de eventos.

### 4. `calcEv` — P&L da noite (resultado por evento)

- **Fórmula:** Resultado = ReceitaCasa − CustosDiretos − Rateio. Receita Casa = barLíquido + porta + caixinhaCasa. Custos diretos = dj + seguranca + staff + outros.
- **Veredito:** código correto (divisão por zero da margem tratada, NaN blindado, `saveEv` é a validação de entrada mais forte do sistema). **Risco semântico médio.**
- **Achados:**
  - **PONTO CRÍTICO:** o "Resultado da Noite" **NÃO** inclui o CMV (custo da bebida vendida). É resultado de **contribuição**, não lucro real. O CMV é consolidado mensalmente (`cmvRealMensal`), não por evento. Risco de interpretação: confundir com lucro final, ainda mais com futuros gerentes/operadores. *Decisão do Vitor:* rotular como **"Resultado da Noite (antes do CMV)"** com subtítulo explicativo.
  - **Custo direto em branco infla o resultado sem aviso.** *Decisão:* NÃO criar aviso automático (campo zerado é legítimo demais → geraria ruído); eventual destaque de "evento sem nenhum custo direto" no fechamento é de baixíssima prioridade.

## Melhorias identificadas (pós ponto-zero, não-bug)

1. Congelar `preco_compra` na data da contagem (`cmvRealMensal`).
2. Faixa visual de aviso para estoque negativo (`estoqueAtual`).
3. Aviso de dupla contagem `estoque_inicial` + compras (`estoqueAtual`).
4. Aviso quando `datasNoMes` != nº de eventos (`rateio`).
5. Rotular "Resultado da Noite (antes do CMV)" (`calcEv`).
6. Avisos de silenciamento (`preco_compra` / `c.total` ausentes no CMV).

## Cenários de teste para rodar com dados reais (pós ponto-zero)

### `cmvRealMensal`

| Cenário | Resultado esperado |
| --- | --- |
| Sanity check: mesma contagem nos 2 meses | CMV = Compras do mês (estoque inicial = estoque final, se anulam) |
| Primeiro mês: sem inventário inicial | Mostra "pendente", não número falso |
| Virada de ano: mês 2026-01 | Busca corretamente o inventário de 2025-12 como estoque inicial |
| Produto sem `preco_compra` | Some da valoração **silenciosamente** (vale R$ 0, sem aviso) |

### `estoqueAtual`

| Cenário | Resultado esperado |
| --- | --- |
| Produto novo com `estoque_inicial` + compras | Checar **dupla contagem** (soma os dois antes da 1ª contagem) |
| Saldo negativo (baixa > entradas) | Aparece **visível** (negativo, não travado em zero) |

### `rateio`

| Cenário | Resultado esperado |
| --- | --- |
| `datasNoMes` != nº de eventos | A soma dos rateios **não fecha** com `totalFixo` |

### `calcEv`

| Cenário | Resultado esperado |
| --- | --- |
| Resultado positivo da noite | Conferir contra o CMV mensal — pode ser contribuição positiva e **lucro real negativo** |
