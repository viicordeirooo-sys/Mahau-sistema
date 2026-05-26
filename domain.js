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

  // Valor (R$) de uma contagem física de inventário: Σ qtd × preco_compra.
  valorInventario(contagens, produtos){
    if(!contagens) return 0;
    const preco={}; (produtos||[]).forEach(p=>{preco[p.id]=p.preco_compra||0;});
    return Object.entries(contagens).reduce((s,[pid,qtd])=>s+(parseFloat(qtd)||0)*(preco[pid]||0),0);
  },

  // Mês anterior: "2026-05" → "2026-04"; "2026-01" → "2025-12". Não-"YYYY-MM" → "".
  mesAnterior(ym){
    if(typeof ym!=="string"||!/^\d{4}-\d{2}$/.test(ym)) return "";
    let [y,m]=ym.split("-").map(Number);
    m-=1; if(m===0){m=12;y-=1;}
    return `${y}-${String(m).padStart(2,"0")}`;
  },

  // Índice de estoque (em UNIDADES) baseado na ÚLTIMA contagem física + compras desde então.
  //   contagens: [{ createdAtMs, contagens:{produtoId: qtd} }]  (semanal + mensal unidos)
  //   compras:   [{ produto_id, qtd, createdAtMs }]
  // Retorna { [pid]: { baseQty, baseMs, hasBase, comprasSince } }.
  estoqueIndex(produtos, compras, contagens){
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
      idx[p.id]={baseQty:b?b.qtd:0, baseMs:b?b.ms:-1, hasBase:!!b, comprasSince:0};
    });
    (compras||[]).forEach(c=>{
      const e=idx[c.produto_id]; if(!e) return;
      // sem contagem ainda → conta todas as compras; com contagem → só as posteriores a ela
      if(!e.hasBase || (c.createdAtMs||0) > e.baseMs) e.comprasSince += (c.qtd||0);
    });
    return idx;
  },

  // Estoque atual (em unidades): última contagem física + compras desde então.
  // Produto nunca contado → fallback estoque_inicial + todas as compras.
  estoqueAtualFrom(produto, idx){
    if(!produto) return 0;
    const e=(idx&&idx[produto.id])||{baseQty:0,hasBase:false,comprasSince:0};
    return (e.hasBase ? e.baseQty : (produto.estoque_inicial||0)) + e.comprasSince;
  },

  // Custo (CMV unitário) de uma ficha, somando ingredientes (R$/ml × ml).
  calcCustoFicha(ficha, produtos){
    if(!ficha || !ficha.ingredientes || !ficha.ingredientes.length) return 0;
    let c=0;
    ficha.ingredientes.forEach(i=>{
      const p=(produtos||[]).find(x=>x.id===i.produto_id);
      if(p&&p.preco_compra&&p.capacidade_ml) c+=(i.quantidade_ml||0)*(p.preco_compra/p.capacidade_ml);
    });
    return c;
  },

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

  // Data do evento a partir do título da Zig ("...no dia 22/05/2026") → ISO. Senão "".
  extrairDataZig(matrix){
    for(const row of (matrix||[]).slice(0,5)) for(const cell of (row||[])){
      const m=/(\d{2})\/(\d{2})\/(\d{4})/.exec(cell==null?"":String(cell));
      if(m) return `${m[3]}-${m[2]}-${m[1]}`;
    }
    return "";
  },

  // Parser da aba "Total de produtos vendidos" da Zig (header dinâmico).
  parseZigVendas(matrix){
    const MAP={sku:"sku",nome:"nome",categoria:"categoria","operacao":"operacao",montavel:"montavel",
      quantidade:"quantidade","valor unitario":"valor_unitario",subtotal:"subtotal",descontos:"descontos","valor total":"valor_total"};
    const {hRow,col}=Domain._detectHeader(matrix,["sku","nome","quantidade"],MAP);
    if(hRow<0||!col||col.sku===undefined||col.nome===undefined) return {erro:"Aba de vendas: cabeçalho não encontrado (SKU/Nome/Quantidade).",itens:[]};
    const num=v=>{const n=parseFloat(v);return isNaN(n)?0:n;}, txt=v=>(v==null?"":String(v)).trim();
    const bool=v=>v===true||["sim","true","1"].includes(Domain._norm(v));
    const itens=[];
    for(let i=hRow+1;i<matrix.length;i++){
      const r=matrix[i]||[]; const sku=txt(r[col.sku]); if(!sku) continue;
      itens.push({ sku, nome:col.nome!=null?txt(r[col.nome]):"", categoria:col.categoria!=null?txt(r[col.categoria]):"",
        montavel: col.montavel!=null?bool(r[col.montavel]):false,
        quantidade: col.quantidade!=null?num(r[col.quantidade]):0,
        valor_total: col.valor_total!=null?num(r[col.valor_total]):0 });
    }
    return {erro:null,hRow,itens};
  },

  // Parser da aba "Montáveis" da Zig (header dinâmico).
  parseZigMontaveis(matrix){
    const MAP={sku:"sku_pai",produto:"produto_pai","categoria produto":"categoria",
      "etapa montavel":"etapa","item montavel":"item_montavel",quantidade:"quantidade"};
    const {hRow,col}=Domain._detectHeader(matrix,["sku","item montavel"],MAP);
    if(hRow<0||!col||col.item_montavel===undefined) return {erro:"Aba de montáveis: cabeçalho não encontrado (SKU/Item Montável).",itens:[]};
    const num=v=>{const n=parseFloat(v);return isNaN(n)?0:n;}, txt=v=>(v==null?"":String(v)).trim();
    const itens=[];
    for(let i=hRow+1;i<matrix.length;i++){
      const r=matrix[i]||[]; const sku=txt(r[col.sku_pai]); if(!sku) continue;
      itens.push({ sku_pai:sku, produto_pai:col.produto_pai!=null?txt(r[col.produto_pai]):"",
        categoria:col.categoria!=null?txt(r[col.categoria]):"", etapa:col.etapa!=null?txt(r[col.etapa]):"",
        item_montavel:txt(r[col.item_montavel]), quantidade:col.quantidade!=null?num(r[col.quantidade]):0 });
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

};

if (typeof module!=='undefined' && module.exports) module.exports = Domain;
