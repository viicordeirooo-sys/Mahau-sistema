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

  // Índice de movimentação de estoque construído em UMA passada.
  // Retorna { [produtoId]: { entradasMl, consumoMl } }. Tudo em ml.
  estoqueIndex(produtos, fichas, compras, vendas){
    const cap={};      (produtos||[]).forEach(p=>{cap[p.id]=p.capacidade_ml||1;});
    const fichaMap={}; (fichas||[]).forEach(f=>{fichaMap[f.id]=f;});
    const idx={};
    const get=pid=>(idx[pid]||(idx[pid]={entradasMl:0,consumoMl:0}));
    (compras||[]).forEach(c=>{ if(c.produto_id) get(c.produto_id).entradasMl+=(c.qtd||0)*(cap[c.produto_id]||1); });
    (vendas||[]).forEach(v=>{
      const qtd=(v.qtd_vendida||0)+(v.qtd_cortesia||0);
      if(v.tipo==="produto"&&v.item_id){ get(v.item_id).consumoMl+=qtd*(cap[v.item_id]||1); }
      else if(v.tipo==="ficha"){
        const f=fichaMap[v.item_id];
        if(f&&f.ingredientes) f.ingredientes.forEach(ing=>{
          if(ing.produto_id) get(ing.produto_id).consumoMl+=qtd*(ing.quantidade_ml||0);
        });
      }
    });
    return idx;
  },

  // Estoque atual (em unidades) de um produto, dado o índice pré-construído.
  estoqueAtualFrom(produto, idx){
    if(!produto) return 0;
    const cap=produto.capacidade_ml||1;
    const agg=(idx&&idx[produto.id])||{entradasMl:0,consumoMl:0};
    return ((produto.estoque_inicial||0)*cap + agg.entradasMl - agg.consumoMl)/cap;
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

  // CMV e receita de bar de um evento (expande fichas em ingredientes).
  // Vendas "manual" (ZigPay não mapeado): receita = valor_total do POS, CMV = 0.
  cmvEvento(eid, vendas, produtos, fichas){
    let cmv=0, rec_bar=0;
    (vendas||[]).filter(v=>v.evento_id===eid).forEach(v=>{
      const qtd=(v.qtd_vendida||0)+(v.qtd_cortesia||0);
      const qv=v.qtd_vendida||0;
      if(v.tipo==="produto"){
        const p=(produtos||[]).find(x=>x.id===v.item_id);
        if(p){ cmv+=qtd*(p.preco_compra||0); rec_bar+=qv*(p.preco_venda||0); }
      }
      if(v.tipo==="ficha"){
        const f=(fichas||[]).find(x=>x.id===v.item_id);
        if(f){
          rec_bar+=qv*(f.preco_venda||0);
          if(f.ingredientes) f.ingredientes.forEach(ing=>{
            const p=(produtos||[]).find(x=>x.id===ing.produto_id);
            if(p&&p.preco_compra&&p.capacidade_ml) cmv+=qtd*(ing.quantidade_ml||0)*(p.preco_compra/p.capacidade_ml);
          });
        }
      }
      if(v.tipo==="manual"){ rec_bar += (v.valor_total||0); }
    });
    return {cmv, rec_bar};
  },

  // Nº de vendas importadas ainda não mapeadas a um produto/ficha (CMV pendente).
  qtdNaoMapeadas(eid, vendas){
    return (vendas||[]).filter(v=>v.evento_id===eid && v.tipo==="manual").length;
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

  // P&L de um evento. rateioVal = valor já calculado por Domain.rateio(...).
  calcEv(evento, vendas, produtos, fichas, rateioVal){
    const entrada=evento.entrada||0;
    const {cmv,rec_bar}=Domain.cmvEvento(evento.id, vendas, produtos, fichas);
    const rec=rec_bar+entrada;
    const dir=(evento.dj||0)+(evento.seguranca||0)+(evento.staff||0)+(evento.outros||0);
    const res=rec-cmv-dir-(rateioVal||0);
    return {rec,cmv,cmvP:rec?cmv/rec:0,dir,res,mg:rec?res/rec:0,rec_bar};
  },

};

if (typeof module!=='undefined' && module.exports) module.exports = Domain;
