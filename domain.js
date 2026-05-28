// domain.js — Camada de domínio do Mahau: cálculos PUROS, sem DOM e sem estado
// global. Recebem os dados por parâmetro. Carregado como script clássico antes do
// app (define o global `Domain`) e testável em Node via require (rodapé no fim).
//
// A memoização do índice de estoque e a invalidação de cache vivem na camada de
// app (index.html), não aqui — aqui tudo é função pura.

const Domain = {

  // Filtro de período: item pertence ao mês selecionado.
  // mesSel = "YYYY-MM" ou null/"" (= todos os meses).
  noMes(dateStr, mesSel){
    if(!mesSel) return true;
    if(!dateStr) return false;
    return dateStr.slice(0,7)===mesSel;
  },

  // "YYYY-MM-DD" → "DD/MM/YYYY". Outros formatos (ex.: "dd/mm" legado) passam direto.
  fmtData(d){
    if(typeof d!=="string") return "";
    const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
  },

  // Período "YYYY-MM" a partir de "YYYY-MM-DD" ou "YYYY-MM". "dd/mm" legado → "".
  mesDeData(d){
    if(typeof d!=="string") return "";
    const m=/^(\d{4}-\d{2})/.exec(d);
    return m ? m[1] : "";
  },

  // Fonte única dos campos de criação de um documento. Usada pelo FS.save E pelos
  // writers diretos (seeds). ts = firebase serverTimestamp().
  camposCriacao(data, ts){
    return {...(data||{}), orgId:(data&&data.orgId)||"default", createdAt:ts, updatedAt:ts};
  },

  // Valor (R$) de uma contagem física + diagnóstico de órfãos.
  //  orfaos: produto_id na contagem mas inexistente em `produtos` (deletado) — entra como R$0.
  valorInventarioDetalhado(contagens, produtos){
    if(!contagens) return {valor:0, orfaos:[]};
    const prodById={}; (produtos||[]).forEach(p=>{ if(p&&p.id) prodById[p.id]=p; });
    const orfaos={};
    let v=0;
    Object.entries(contagens).forEach(([pid,qtd])=>{
      const p=prodById[pid];
      if(!p){ if(pid) orfaos[pid]={produto_id:pid}; return; }
      v += (parseFloat(qtd)||0)*(p.preco_compra||0);
    });
    return {valor:v, orfaos:Object.values(orfaos)};
  },

  // Delegate: mantém o retorno NUMÉRICO de antes.
  valorInventario(contagens, produtos){ return Domain.valorInventarioDetalhado(contagens, produtos).valor; },

  // Mês anterior: "2026-05" → "2026-04"; "2026-01" → "2025-12". Não-"YYYY-MM" → "".
  mesAnterior(ym){
    if(typeof ym!=="string"||!/^\d{4}-\d{2}$/.test(ym)) return "";
    let [y,m]=ym.split("-").map(Number);
    m-=1; if(m===0){m=12;y-=1;}
    return `${y}-${String(m).padStart(2,"0")}`;
  },

  // Índice de estoque (em UNIDADES) = ÚLTIMA contagem física + compras − baixas de venda, desde a contagem.
  //   contagens: [{ createdAtMs, contagens:{produtoId: qtd} }]  (semanal + mensal unidos)
  //   compras:   [{ produto_id, qtd, createdAtMs }]
  //   baixas:    [{ produto_id, unidades, createdAtMs }]  (consumo de venda por evento — import Zig; opcional)
  // Retorna { [pid]: { baseQty, baseMs, hasBase, comprasSince, baixasSince } }.
  estoqueIndex(produtos, compras, contagens, baixas){
    const base={}; // pid -> {qtd, ms} da contagem mais recente que inclui o produto
    (contagens||[]).forEach(inv=>{
      const ms=inv.createdAtMs||0;
      Object.entries(inv.contagens||{}).forEach(([pid,qtd])=>{
        if(!base[pid] || ms>base[pid].ms) base[pid]={qtd:parseFloat(qtd)||0, ms};
      });
    });
    const idx={};
    (produtos||[]).forEach(p=>{
      const b=base[p.id];
      idx[p.id]={baseQty:b?b.qtd:0, baseMs:b?b.ms:-1, hasBase:!!b, comprasSince:0, baixasSince:0};
    });
    (compras||[]).forEach(c=>{
      const e=idx[c.produto_id]; if(!e) return;
      // sem contagem ainda → conta todas as compras; com contagem → só as posteriores a ela
      if(!e.hasBase || (c.createdAtMs||0) > e.baseMs) e.comprasSince += (c.qtd||0);
    });
    // baixas de venda (import Zig por evento) — mesma regra de timing das compras:
    // sem contagem → todas; com contagem → só as posteriores a ela.
    (baixas||[]).forEach(b=>{
      const e=idx[b.produto_id]; if(!e) return;
      if(!e.hasBase || (b.createdAtMs||0) > e.baseMs) e.baixasSince += (b.unidades||0);
    });
    return idx;
  },

  // Estoque atual (em unidades): última contagem física + compras − baixas de venda, desde então.
  // Produto nunca contado → fallback estoque_inicial + todas as compras − todas as baixas.
  estoqueAtualFrom(produto, idx){
    if(!produto) return 0;
    const e=(idx&&idx[produto.id])||{baseQty:0,hasBase:false,comprasSince:0,baixasSince:0};
    return (e.hasBase ? e.baseQty : (produto.estoque_inicial||0)) + e.comprasSince - (e.baixasSince||0);
  },

  // Custo (CMV unitário) de uma ficha + diagnóstico do que NÃO entrou no custo.
  //  orfaos:      produto_id que não existe mais em `produtos` (deletado) — referência quebrada.
  //  incompletos: produto existe mas sem preco_compra e/ou capacidade_ml — cadastro incompleto.
  // Antes os 3 casos eram pulados em silêncio; aqui são reportados SEM mudar o custo somado.
  calcCustoFichaDetalhado(ficha, produtos){
    if(!ficha || !ficha.ingredientes || !ficha.ingredientes.length) return {custo:0, orfaos:[], incompletos:[]};
    const orfaos={}, incompletos={};
    let c=0;
    ficha.ingredientes.forEach(i=>{
      const p=(produtos||[]).find(x=>x.id===i.produto_id);
      if(!p){ if(i.produto_id) orfaos[i.produto_id]={produto_id:i.produto_id}; return; }
      if(!p.preco_compra || !p.capacidade_ml){
        incompletos[p.id]={produto_id:p.id, nome_produto:p.nome||"", semPreco:!p.preco_compra, semCapacidade:!p.capacidade_ml};
        return;
      }
      c+=(i.quantidade_ml||0)*(p.preco_compra/p.capacidade_ml);
    });
    return {custo:c, orfaos:Object.values(orfaos), incompletos:Object.values(incompletos)};
  },

  // Delegate: mantém o retorno NUMÉRICO de antes (call sites que só querem o custo).
  calcCustoFicha(ficha, produtos){ return Domain.calcCustoFichaDetalhado(ficha, produtos).custo; },

  // Soma dos custos fixos do mês selecionado (ou de todos, se mesSel vazio).
  totalFixo(custos, mesSel){
    return (custos||[]).filter(c=>!mesSel||(c.mes&&c.mes===mesSel)).reduce((s,c)=>s+(c.valor||0),0);
  },

  // Rateio do custo fixo por data: total do mês ÷ nº de datas no mês (config).
  rateio(custos, config, mesSel){
    const dn=(config&&config.datasNoMes)||0;
    return dn>0 ? (Domain.totalFixo(custos,mesSel)/dn) : 0;
  },

  // P&L da NOITE (novo modelo). A caixinha sai do bar bruto; pct_casa em PERCENT (0–100).
  // O CMV NÃO entra aqui — é consolidado mensalmente via inventário (cmvRealMensal).
  // rateioVal = rateio do custo fixo já calculado por Domain.rateio(...).
  calcEv(evento, rateioVal){
    const barBruto=evento.bar_bruto||0;
    const caixinha=evento.caixinha||0;
    const porta=evento.entrada||0;
    const caixinhaCasa=caixinha*((evento.pct_casa||0)/100);
    const caixinhaFunc=caixinha-caixinhaCasa;
    const barLiquido=barBruto-caixinha;
    const receitaCasa=barLiquido+porta+caixinhaCasa;
    const custosDiretos=(evento.dj||0)+(evento.seguranca||0)+(evento.staff||0)+(evento.outros||0);
    const rat=rateioVal||0;
    const resultado=receitaCasa-custosDiretos-rat;
    return {
      barBruto, caixinha, caixinhaCasa, caixinhaFunc, barLiquido, porta,
      receitaCasa, custosDiretos, rateio:rat, resultado, mg:receitaCasa?resultado/receitaCasa:0
    };
  },

  // ── CONCILIAÇÃO ────────────────────────────────────────────────────────────
  // Normaliza texto p/ casar nomes/colunas: trim + minúsculo + sem acento + espaços colapsados.
  _norm(s){ return (s==null?"":String(s)).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/\s+/g," "); },

  // Parser da planilha de estoque da funcionária (aba "Produtos").
  // matrix = array-de-arrays (sheet_to_json header:1). Detecta o header dinamicamente.
  parseEstoqueRows(matrix){
    const N=Domain._norm;
    const MAP={ "produto":"nome","departamento":"departamento","setor":"setor",
      "quantidade":"quantidade_embalagem","medida":"medida",
      "estoque minimo":"estoque_minimo","estoque atual":"estoque_contado","custo":"custo" };
    let hRow=-1, col=null;
    for(let i=0;i<(matrix||[]).length;i++){
      const cells=(matrix[i]||[]).map(N);
      if(cells.includes("produto") && (cells.includes("custo")||cells.includes("estoque atual"))){
        hRow=i; col={}; cells.forEach((c,idx)=>{ if(MAP[c]!==undefined) col[MAP[c]]=idx; }); break;
      }
    }
    if(hRow<0 || !col || col.nome===undefined) return {erro:"Cabeçalho não encontrado (esperado: Produto, Custo, Estoque Atual...).", itens:[]};
    const num=v=>{ const n=parseFloat(v); return isNaN(n)?0:n; };
    const txt=v=>(v==null?"":String(v)).trim();
    const itens=[];
    for(let i=hRow+1;i<matrix.length;i++){
      const r=matrix[i]||[];
      const nome=txt(r[col.nome]);
      if(!nome) continue;
      itens.push({
        nome,
        departamento: col.departamento!=null?txt(r[col.departamento]):"",
        setor:        col.setor!=null?txt(r[col.setor]):"",
        quantidade_embalagem: col.quantidade_embalagem!=null?num(r[col.quantidade_embalagem]):0,
        medida:       col.medida!=null?txt(r[col.medida]):"",
        estoque_minimo:  col.estoque_minimo!=null?num(r[col.estoque_minimo]):0,
        estoque_contado: col.estoque_contado!=null?num(r[col.estoque_contado]):0,
        custo:        col.custo!=null?num(r[col.custo]):0,
      });
    }
    return {erro:null, headerRow:hRow, itens};
  },

  // Detecta a linha de header (que contém todas as `chaves` normalizadas) e devolve
  // {hRow, col} com col = nomeColunaNormalizado→índice apenas para colunas em MAP.
  _detectHeader(matrix, chaves, MAP){
    const N=Domain._norm;
    for(let i=0;i<(matrix||[]).length;i++){
      const cells=(matrix[i]||[]).map(N);
      if(chaves.every(k=>cells.includes(k))){
        const col={}; cells.forEach((c,idx)=>{ if(MAP[c]!==undefined && col[MAP[c]]===undefined) col[MAP[c]]=idx; });
        return {hRow:i, col};
      }
    }
    return {hRow:-1, col:null};
  },

  // Período do título da Saída Geral ("...entre 20/05/2026 e 25/05/2026") → {inicio,fim} ISO.
  extrairPeriodoZig(matrix){
    const datas=[];
    for(const row of (matrix||[]).slice(0,5)) for(const cell of (row||[])){
      const s=cell==null?"":String(cell);
      const re=/(\d{2})\/(\d{2})\/(\d{4})/g; let m;
      while((m=re.exec(s))) datas.push(`${m[3]}-${m[2]}-${m[1]}`);
    }
    datas.sort();
    return { inicio: datas[0]||"", fim: datas[datas.length-1]||datas[0]||"" };
  },

  // Parser da "Saída geral de produtos" da Zig (consolidado da semana; header dinâmico).
  // Colunas: SKU, Produto, Quantidade. Sem montáveis, sem valor.
  //
  // ⚠️ DUPLA CONTAGEM NATIVA (relevante para o motor de conciliação — Sprint 2):
  // A Saída Geral lista o COMBO PAI e os ITENS INTERNOS dele como linhas separadas.
  // Ex.: Combo "03 Gold Label" (SKU 70o3, 4 un) E "Garrafa Gold Label" (SKU 173, 48 un)
  // aparecem ambos — as 48 garrafas JÁ ESTÃO dentro dos 4 combos (4×12=48).
  // O motor NÃO deve somar os dois. Estratégias (definir no Sprint 2):
  //   (a) identificar combos via mapeamento_zig.tipo==="combo" e descontar os itens
  //       internos do total; ou
  //   (b) consumir SÓ os SKUs montáveis ("Garrafa X"/"Dose Y") e IGNORAR os SKUs de combo pai.
  parseSaidaGeral(matrix){
    const MAP={sku:"sku",produto:"produto",quantidade:"quantidade"};
    const {hRow,col}=Domain._detectHeader(matrix,["sku","produto","quantidade"],MAP);
    if(hRow<0||!col||col.sku===undefined||col.quantidade===undefined) return {erro:"Saída Geral: cabeçalho não encontrado (SKU/Produto/Quantidade).",itens:[]};
    const num=v=>{const n=parseFloat(v);return isNaN(n)?0:n;}, txt=v=>(v==null?"":String(v)).trim();
    const itens=[];
    for(let i=hRow+1;i<matrix.length;i++){
      const r=matrix[i]||[]; const sku=txt(r[col.sku]); if(!sku) continue;
      itens.push({ sku, produto: col.produto!=null?txt(r[col.produto]):"", quantidade: num(r[col.quantidade]) });
    }
    return {erro:null,hRow,itens};
  },

  // Casa itens parseados com o cadastro `produtos` (por nome normalizado) e marca flags.
  casarEstoque(itens, produtos){
    const N=Domain._norm;
    const byNome={}; (produtos||[]).forEach(p=>{ byNome[N(p.nome)]=p; });
    return (itens||[]).map(it=>{
      const p=byNome[N(it.nome)];
      const custoAnterior=p?(p.preco_compra||0):0;
      return {...it,
        produto_id: p?p.id:null,
        novo: !p,
        custoAnterior,
        custoVariou: !!(p && custoAnterior>0 && it.custo>0 && Math.abs(it.custo-custoAnterior)/custoAnterior>0.30),
        negativo: it.estoque_contado<0,
      };
    });
  },

  // R$ no formato US da Zig ("R$57.00", "R$1,210.00", "R$0.00") → número.
  // Vírgula = milhar, ponto = decimal (confirmado nos arquivos reais).
  _numBR(v){
    if(v==null) return 0;
    const s=String(v).replace(/r\$/i,"").replace(/\s/g,"").replace(/,/g,"").trim();
    if(!s) return 0;
    const n=parseFloat(s); return isNaN(n)?0:n;
  },

  // Data no formato US dos relatórios de linha da Zig ("5/23/26" = M/D/YY) → ISO "2026-05-23".
  // Aceita ano de 2 ou 4 dígitos. ⚠️ Diferente do título (que usa DD/MM/YYYY → extrairPeriodoZig).
  _dataUS(v){
    const s=(v==null?"":String(v)).trim();
    const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if(!m) return "";
    let mo=m[1], d=m[2], y=m[3];
    if(y.length===2) y="20"+y;
    return `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  },

  // Parser da "Bonificação por produto" (cortesias) da Zig. Header dinâmico.
  // ⚠️ Há DUAS colunas chamadas "Categoria do Produto": a 1ª (à esquerda de "Produto")
  // é o PROMOTER/grupo da cortesia; a 2ª (à direita) é a categoria do produto.
  // Por isso casamos por posição relativa a "Produto", não por nome de coluna.
  parseCortesias(matrix){
    const N=Domain._norm;
    let hRow=-1, pCol=-1, vCol=-1, voCol=-1;
    for(let i=0;i<(matrix||[]).length;i++){
      const cells=(matrix[i]||[]).map(N);
      const pi=cells.indexOf("produto");
      const vi=cells.findIndex(c=>c.includes("bonificacao recebida durante"));
      if(pi>=0 && vi>=0){
        hRow=i; pCol=pi; vCol=vi;
        voCol=cells.findIndex(c=>c.includes("bonificacao recebida em outro"));
        break;
      }
    }
    if(hRow<0) return {erro:"Cortesias: cabeçalho não encontrado (esperado: Produto + Bonificação recebida durante o período).", itens:[]};
    const promoCol=pCol-1, catCol=pCol+1;
    const txt=v=>(v==null?"":String(v)).trim();
    const itens=[];
    for(let i=hRow+1;i<matrix.length;i++){
      const r=matrix[i]||[]; const produto=txt(r[pCol]); if(!produto) continue;
      itens.push({
        promoter: promoCol>=0?txt(r[promoCol]):"",
        produto,
        categoria: txt(r[catCol]),
        valor_brl: Domain._numBR(r[vCol]),
        valor_outro_periodo: voCol>=0?Domain._numBR(r[voCol]):0,
      });
    }
    return {erro:null, hRow, itens};
  },

  // Parser de "Produtos estornados/cancelados" da Zig. Header dinâmico.
  // Mantém `tipo` cru ("Estornado"|"Cancelado") — só "Estornado" devolve ao estoque (motor).
  parseEstornos(matrix){
    const MAP={"data":"data","nome do produto":"produto","categoria":"categoria","tipo":"tipo",
      "motivo":"motivo","quantidade":"quantidade","valor":"valor"};
    const {hRow,col}=Domain._detectHeader(matrix,["data","nome do produto","tipo","quantidade"],MAP);
    if(hRow<0||!col||col.produto===undefined||col.tipo===undefined) return {erro:"Estornos: cabeçalho não encontrado (Data/Nome do Produto/Tipo/Quantidade).",itens:[]};
    const num=v=>{const n=parseFloat(v);return isNaN(n)?0:n;}, txt=v=>(v==null?"":String(v)).trim();
    const itens=[];
    for(let i=hRow+1;i<matrix.length;i++){
      const r=matrix[i]||[]; const produto=col.produto!=null?txt(r[col.produto]):""; if(!produto) continue;
      itens.push({
        data: col.data!=null?Domain._dataUS(r[col.data]):"",
        produto,
        categoria: col.categoria!=null?txt(r[col.categoria]):"",
        tipo: txt(r[col.tipo]),
        motivo: col.motivo!=null?txt(r[col.motivo]):"",
        quantidade: col.quantidade!=null?num(r[col.quantidade]):0,
        valor: col.valor!=null?Domain._numBR(r[col.valor]):0,
      });
    }
    return {erro:null, hRow, itens};
  },

  // Período do título — cortesias e estornos usam o MESMO formato ("...entre DD/MM/YYYY e DD/MM/YYYY")
  // que a Saída Geral, então delegamos ao extrator existente (sem duplicar o regex).
  extrairPeriodoCortesias(matrix){ return Domain.extrairPeriodoZig(matrix); },
  extrairPeriodoEstornos(matrix){ return Domain.extrairPeriodoZig(matrix); },

  // ── MOTOR DE CONCILIAÇÃO (Sprint 2 · 2d) ──────────────────────────────────────
  // Produtos sem ficha técnica definida → não entram no cálculo de desvio (status SEM FICHA).
  PRODUTOS_SEM_FICHA: ["Gin Mahau","Kawai - vodka","Gelo De Coco"],
  semFicha(nome){
    const n=Domain._norm(nome);
    return Domain.PRODUTOS_SEM_FICHA.some(x=>Domain._norm(x)===n);
  },

  // Traduz "produto Zig + quantidade" em baixas de estoque: [{produto_id, unidades}].
  // Compartilhado por venda (mapeado por SKU), cortesia e estorno (mapeados por nome).
  //  - ignorar         → nada
  //  - direto/montavel → TODAS as regras: por regra, qtd × quantidade_baixa; se unidade "ml" e o
  //                      produto tem capacidade_ml, converte p/ garrafas (ml ÷ capacidade_ml).
  //                      Drinks com vários ingredientes (Long Island = vodka+gin+tequila+rum+
  //                      cointreau) baixam 1 linha por ingrediente. 1 regra → mesmo resultado de antes.
  //  - combo           → SÓ o mixer (Red Bull/tônica): qtd × redbull_qtd do mixer_produto_id.
  //                      A garrafa do combo NÃO entra aqui — ela é baixada pela linha montável
  //                      separada da Saída Geral (evita a dupla contagem nativa dos combos).
  resolverBaixa(mapping, qtd, prodById){
    if(!mapping || !qtd) return [];
    const t=mapping.tipo;
    if(t==="ignorar") return [];
    if(t==="combo"){
      const mid=mapping.mixer_produto_id, mq=mapping.redbull_qtd||0;
      if(!mid || !mq) return [];
      return [{produto_id:mid, unidades: qtd*mq}];
    }
    const out=[];
    (mapping.regras||[]).forEach(r=>{
      if(!r || !r.produto_id) return;
      const qb=r.quantidade_baixa||0; if(!qb) return;
      if((r.unidade||"un").toLowerCase()==="ml"){
        const p=prodById&&prodById[r.produto_id], cap=(p&&p.capacidade_ml)||0;
        if(cap>0){ out.push({produto_id:r.produto_id, unidades:(qtd*qb)/cap}); return; }
        out.push({produto_id:r.produto_id, nome_produto:r.nome_produto||"", unidades:0, erro:"ml_sem_capacidade"}); return;
      }
      out.push({produto_id:r.produto_id, unidades: qtd*qb});
    });
    return out;
  },

  // Motor principal. Fórmula por produto: esperado = antes + compras − venda − cortesia + estorno;
  // desvio = real(depois) − esperado. Devolve resultados, totais e meta do que ficou de fora.
  // params: {estoqueAntes, estoqueDepois, saidaGeral, cortesias, estornos, compras,
  //          mapeamentos, produtos, opts:{periodo_inicio, periodo_fim}}
  conciliar(params){
    const N=Domain._norm, p=params||{};
    const estoqueAntes=p.estoqueAntes||[], estoqueDepois=p.estoqueDepois||[];
    const saida=p.saidaGeral||[], cortesias=p.cortesias||[], estornos=p.estornos||[];
    const compras=p.compras||[], mapeamentos=p.mapeamentos||[], produtos=p.produtos||[];
    const opts=p.opts||{}, ini=opts.periodo_inicio||"", fim=opts.periodo_fim||"";

    const prodById={}; produtos.forEach(x=>{ if(x&&x.id) prodById[x.id]=x; });
    const mapBySku={}, mapByNome={};
    mapeamentos.forEach(m=>{ if(m.sku_zig) mapBySku[m.sku_zig]=m; if(m.nome_zig) mapByNome[N(m.nome_zig)]=m; });

    const venda={}, cortesia={}, estornoDev={}, comprasPid={};
    const add=(o,pid,u)=>{ if(!pid) return; o[pid]=(o[pid]||0)+u; };
    const mlSemCap={};
    const addErro=b=>{ if(b&&b.erro==="ml_sem_capacidade"&&b.produto_id) mlSemCap[b.produto_id]={produto_id:b.produto_id, nome_produto:b.nome_produto||""}; };

    // 1) consumo de venda (Saída Geral) — combo-pai baixa só o mixer (anti-dupla-contagem)
    const skusNaoMapeados=[];
    saida.forEach(v=>{
      const m=mapBySku[v.sku];
      if(!m){ if(v.sku) skusNaoMapeados.push(v.sku); return; }
      Domain.resolverBaixa(m, v.quantidade||0, prodById).forEach(b=>{ if(b.erro){ addErro(b); return; } add(venda,b.produto_id,b.unidades); });
    });

    // 2) consumo de cortesia — qtd = round(valor_brl / preco_zig); casa por nome
    let cortesiasSemMapa=0, cortesiasSemPreco=0;
    cortesias.forEach(c=>{
      const m=mapByNome[N(c.produto)];
      if(!m){ cortesiasSemMapa++; return; }
      const preco=m.preco_zig||0;
      if(preco<=0){ cortesiasSemPreco++; return; }
      const qtd=Math.round((c.valor_brl||0)/preco);
      if(qtd<=0) return;
      Domain.resolverBaixa(m, qtd, prodById).forEach(b=>{ if(b.erro){ addErro(b); return; } add(cortesia,b.produto_id,b.unidades); });
    });

    // 3) estorno devolvido — só "Estornado" volta ao estoque; casa por nome
    let estornosSemMapa=0;
    estornos.forEach(e=>{
      if(N(e.tipo)!=="estornado") return;
      const m=mapByNome[N(e.produto)];
      if(!m){ estornosSemMapa++; return; }
      Domain.resolverBaixa(m, e.quantidade||0, prodById).forEach(b=>{ if(b.erro){ addErro(b); return; } add(estornoDev,b.produto_id,b.unidades); });
    });

    // 4) compras da semana (reusa a coleção `compras`), por data ISO no período
    compras.forEach(c=>{
      const d=c.data||"";
      if(ini && d<ini) return;
      if(fim && d>fim) return;
      add(comprasPid, c.produto_id, c.qtd||0);
    });

    // 5) universo = produtos contados (antes ∪ depois); exige produto_id
    const antesBy={}, depoisBy={}, custoBy={}, nomeBy={};
    estoqueAntes.forEach(i=>{ if(i.produto_id){ antesBy[i.produto_id]=i.estoque_contado||0; if(i.custo) custoBy[i.produto_id]=i.custo; if(i.nome) nomeBy[i.produto_id]=i.nome; } });
    estoqueDepois.forEach(i=>{ if(i.produto_id){ depoisBy[i.produto_id]=i.estoque_contado||0; if(i.custo) custoBy[i.produto_id]=i.custo; if(i.nome) nomeBy[i.produto_id]=i.nome; } });
    const pids=Object.keys(Object.assign({}, antesBy, depoisBy));

    const resultados=[];
    let total_falta=0, total_sobra=0, cOk=0, cFalta=0, cSobra=0, cSem=0;
    pids.forEach(pid=>{
      const pr=prodById[pid]||{};
      const nome=pr.nome||nomeBy[pid]||pid;
      const antes=antesBy[pid]||0, real=depoisBy[pid]||0;
      const compr=comprasPid[pid]||0, vnd=venda[pid]||0, cor=cortesia[pid]||0, est=estornoDev[pid]||0;
      const esperado=antes+compr-vnd-cor+est;
      const desvio=real-esperado;
      const preco=pr.preco_compra||custoBy[pid]||0;
      const valor_rs=Math.abs(desvio)*preco;
      let status;
      if(Domain.semFicha(nome)){ status="sem_ficha"; cSem++; }
      else if(Math.abs(desvio)<0.5){ status="ok"; cOk++; }
      else if(desvio<0){ status="falta"; cFalta++; total_falta+=valor_rs; }
      else { status="sobra"; cSobra++; total_sobra+=valor_rs; }
      resultados.push({produto_id:pid, nome, antes, compras:compr, venda:vnd, cortesia:cor, estorno:est, esperado, real, desvio, valor_rs, preco_compra:preco, status});
    });
    resultados.sort((a,b)=>b.valor_rs-a.valor_rs);

    return {
      resultados, total_falta, total_sobra,
      contagem:{ok:cOk, falta:cFalta, sobra:cSobra, sem_ficha:cSem, total:resultados.length},
      meta:{
        skus_nao_mapeados:[...new Set(skusNaoMapeados)],
        cortesias_sem_mapa:cortesiasSemMapa, cortesias_sem_preco:cortesiasSemPreco,
        estornos_sem_mapa:estornosSemMapa,
        ml_sem_capacidade:Object.values(mlSemCap)
      }
    };
  },

  // ── IMPORT DE PRODUTOS VENDIDOS POR EVENTO (Sprint 3) ─────────────────────────
  // Arquivo "total-produtos-vendidos" da Zig (POR DIA), com 2 abas:
  //  - Vendidos: SKU, Nome, Categoria, Montável(TRUE/FALSE), Quantidade, Valor unitário, Valor total
  //  - Montáveis: SKU(pai), Produto(pai), Etapa Montável, Item Montável, Quantidade
  // ⚠️ Estrutura DIFERENTE da Saída Geral semanal: aqui a garrafa/mixers de um combo
  // estão SÓ na aba Montáveis (não como linha top-level), por isso a baixa usa as duas abas.

  parseProdutosVendidos(matrix){
    const MAP={"sku":"sku","nome":"nome","categoria":"categoria","montavel":"montavel",
      "quantidade":"quantidade","valor unitario":"valor_unitario","valor total":"valor_total"};
    const {hRow,col}=Domain._detectHeader(matrix,["sku","nome","quantidade"],MAP);
    if(hRow<0||!col||col.sku===undefined||col.quantidade===undefined) return {erro:"Produtos vendidos: cabeçalho não encontrado (SKU/Nome/Quantidade).",itens:[]};
    const num=v=>{const n=parseFloat(v);return isNaN(n)?0:n;}, txt=v=>(v==null?"":String(v)).trim();
    const itens=[];
    for(let i=hRow+1;i<matrix.length;i++){
      const r=matrix[i]||[]; const sku=txt(r[col.sku]); if(!sku) continue;
      itens.push({
        sku,
        nome: col.nome!=null?txt(r[col.nome]):"",
        categoria: col.categoria!=null?txt(r[col.categoria]):"",
        montavel: col.montavel!=null && txt(r[col.montavel]).toUpperCase()==="TRUE",
        quantidade: num(r[col.quantidade]),
        valor_unitario: col.valor_unitario!=null?Domain._numBR(r[col.valor_unitario]):0,
        valor_total: col.valor_total!=null?Domain._numBR(r[col.valor_total]):0,
      });
    }
    return {erro:null, hRow, itens};
  },

  parseMontaveis(matrix){
    const MAP={"sku":"sku_pai","produto":"produto_pai","etapa montavel":"etapa",
      "item montavel":"item_montavel","quantidade":"quantidade"};
    const {hRow,col}=Domain._detectHeader(matrix,["sku","item montavel","quantidade"],MAP);
    if(hRow<0||!col||col.item_montavel===undefined||col.quantidade===undefined) return {erro:"Montáveis: cabeçalho não encontrado (SKU/Item Montável/Quantidade).",itens:[]};
    const num=v=>{const n=parseFloat(v);return isNaN(n)?0:n;}, txt=v=>(v==null?"":String(v)).trim();
    const itens=[];
    for(let i=hRow+1;i<matrix.length;i++){
      const r=matrix[i]||[]; const item=col.item_montavel!=null?txt(r[col.item_montavel]):""; if(!item) continue;
      itens.push({
        sku_pai: col.sku_pai!=null?txt(r[col.sku_pai]):"",
        produto_pai: col.produto_pai!=null?txt(r[col.produto_pai]):"",
        etapa: col.etapa!=null?txt(r[col.etapa]):"",
        item_montavel: item,
        quantidade: num(r[col.quantidade]),
      });
    }
    return {erro:null, hRow, itens};
  },

  // Data do evento — título "...no dia DD/MM/YYYY". Reusa o extrator (que varre as 1ªs linhas).
  extrairDataZigEvento(matrix){ return Domain.extrairPeriodoZig(matrix).inicio || ""; },

  // Traduz o arquivo vendido (2 abas) em baixas de estoque por produto.
  //  - Vendidos Mont=FALSE  → baixa por SKU (resolverBaixa).
  //  - Vendidos Mont=TRUE   → PULADO (é só o "container"; o conteúdo real vem dos montáveis).
  //  - Montáveis            → baixa o item REAL (garrafa/mixer) casando por NOME (resolverBaixa).
  // Itens sem mapeamento (incluindo modifiers como "BEM PASSADO", "SEM LIMÃO") não baixam nada
  // e voltam em naoMapeados para o preview.
  // params: { vendidos, montaveis, mapeamentos, produtos }
  baixaEvento(params){
    const N=Domain._norm, p=params||{};
    const vendidos=p.vendidos||[], montaveis=p.montaveis||[], mapeamentos=p.mapeamentos||[], produtos=p.produtos||[];
    const prodById={}; produtos.forEach(x=>{ if(x&&x.id) prodById[x.id]=x; });
    const mapBySku={}, mapByNome={};
    mapeamentos.forEach(m=>{ if(m.sku_zig) mapBySku[m.sku_zig]=m; if(m.nome_zig) mapByNome[N(m.nome_zig)]=m; });

    const baixas={}, detalhe=[], naoMapSku=[], naoMapNomeRaw=[];
    const add=(pid,u)=>{ if(!pid||!u) return; baixas[pid]=(baixas[pid]||0)+u; };
    const mlSemCap={};
    const addErro=b=>{ if(b&&b.erro==="ml_sem_capacidade"&&b.produto_id) mlSemCap[b.produto_id]={produto_id:b.produto_id, nome_produto:b.nome_produto||""}; };
    const nomeProd=pid=>(prodById[pid]&&prodById[pid].nome)||pid;
    let total_itens=0, total_valor=0;

    // 1) Vendidos — Mont=FALSE baixa por SKU; Mont=TRUE é só container (conteúdo vem dos montáveis)
    vendidos.forEach(v=>{
      total_itens += v.quantidade||0;
      total_valor += v.valor_total||((v.valor_unitario||0)*(v.quantidade||0));
      if(v.montavel) return;
      const m=mapBySku[v.sku];
      if(!m){ naoMapSku.push({sku:v.sku, nome:v.nome, quantidade:v.quantidade||0}); return; }
      Domain.resolverBaixa(m, v.quantidade||0, prodById).forEach(b=>{
        if(b.erro){ addErro(b); return; }
        add(b.produto_id, b.unidades);
        detalhe.push({origem:"venda", chave:v.sku, item:v.nome, qtd_zig:v.quantidade||0,
          produto_id:b.produto_id, produto:nomeProd(b.produto_id), unidades:b.unidades});
      });
    });

    // 2) Montáveis — baixa o item REAL escolhido (garrafa/mixer), casando por NOME
    montaveis.forEach(it=>{
      const m=mapByNome[N(it.item_montavel)];
      if(!m){ naoMapNomeRaw.push({nome:it.item_montavel, quantidade:it.quantidade||0}); return; }
      Domain.resolverBaixa(m, it.quantidade||0, prodById).forEach(b=>{
        if(b.erro){ addErro(b); return; }
        add(b.produto_id, b.unidades);
        detalhe.push({origem:"montavel", chave:it.item_montavel, item:it.item_montavel, qtd_zig:it.quantidade||0,
          produto_id:b.produto_id, produto:nomeProd(b.produto_id), unidades:b.unidades});
      });
    });

    // agrega itens montáveis não mapeados por nome (soma quantidades repetidas)
    const aggNome={};
    naoMapNomeRaw.forEach(x=>{ const k=N(x.nome); if(!aggNome[k]) aggNome[k]={nome:x.nome, quantidade:0}; aggNome[k].quantidade+=x.quantidade; });

    return {
      baixas, detalhe,
      naoMapeados:{ skus:naoMapSku, nomes:Object.values(aggNome), semCapacidade:Object.values(mlSemCap) },
      total_itens, total_valor
    };
  },

};

if (typeof module!=='undefined' && module.exports) module.exports = Domain;
