# MIGRATION.md — Mahau-sistema

Guia operacional pra administradores. Não é referência de código (esse é o CLAUDE.md) — aqui é o passo a passo das tarefas que precisam ser feitas FORA do app (Firebase Console + linha de comando + chave de service account).

## Sumário

1. [Adicionar um novo usuário](#1-adicionar-um-novo-usuário)
2. [Trocar o papel de um usuário](#2-trocar-o-papel-de-um-usuário)
3. [Remover um usuário](#3-remover-um-usuário)
4. [Atualizar Firestore Rules em produção](#4-atualizar-firestore-rules-em-produção)
5. [Renovar a service account key do Admin SDK](#5-renovar-a-service-account-key-do-admin-sdk)

---

## 1. Adicionar um novo usuário

Sempre nessa ordem: (a) criar no Firebase Auth, (b) setar o claim, (c) usuário loga.

### Passo 1.a — Criar no Firebase Auth

1. Abrir https://console.firebase.google.com/project/mahau-sistema/authentication/users
2. Clicar "Adicionar usuário" (botão azul)
3. Preencher email + senha temporária forte
4. Clicar "Adicionar usuário"
5. ⚠️ Comunicar a senha temporária pra pessoa de forma segura (NÃO por email/chat público)

### Passo 1.b — Setar o claim de papel

Decidir o papel:
- **admin**: sócio principal com poder total. RWD em tudo. Pode mexer em config, deletar coisas, gerenciar usuários.
- **manager**: sócio operacional. Read em tudo, write em coleções operacionais, sem deletes, sem mexer em config nem lixeira.
- **staff**: operador. Read+write apenas em estoques e vendas_zig, leitura em catálogos (produtos, mapeamento_zig, semanas_conciliacao). Sem acesso a fichas, compras, eventos, custos, inventarios, cortesias_semana, estornos_semana, conciliacoes, config, lixeira.

(Tabela completa de permissões: ver cabeçalho de `firestore.rules`.)

1. Editar `roles.json` na raiz do projeto (este arquivo é gitignored — só existe local). Adicionar:

```json
{
  "socio@exemplo.com": { "role": "admin" },
  "novo-email@exemplo.com": { "role": "manager" }
}
```

2. Pré-requisito: ter o `*-firebase-adminsdk-*.json` (service account key) na raiz. Ver seção 5 se precisar renovar.

3. Rodar dry-run pra validar:

```
node set-claims.mjs --dry-run
```

Saída esperada: lista de cada email com o claim que será aplicado e o claim atual. Confirma que está como você quer.

4. Aplicar:

```
node set-claims.mjs
```

### Passo 1.c — Usuário loga

1. Pessoa abre https://mahau-sistema.vercel.app e faz login com o email/senha do passo 1.a
2. Trocar a senha temporária no primeiro acesso (a fazer — feature ainda não existe no app; orientar manualmente pelo Console)
3. O token JWT só carrega o novo claim depois de logout/login ou após ~1h de auto-refresh — se a pessoa fez login antes do passo 1.b, ela precisa deslogar e logar de novo

### Validar no DevTools (opcional mas recomendado)

A própria pessoa (ou você ao lado) pode validar que o claim chegou:

1. F12 no navegador (DevTools) → aba Console
2. Colar:

```js
firebase.auth().currentUser.getIdTokenResult(true).then(r => console.log(r.claims))
```

3. Deve aparecer `role: "manager"` (ou o papel atribuído) no JSON

---

## 2. Trocar o papel de um usuário

Mesma sequência do passo 1.b: editar `roles.json` com o novo papel, rodar `node set-claims.mjs --dry-run`, depois `node set-claims.mjs`. Usuário precisa deslogar e logar de novo.

⚠️ Cuidado: rodar `set-claims.mjs` aplica TUDO que está em `roles.json` — se você só quer trocar UM usuário mas o arquivo lista vários, todos vão ser reaplicados (idempotente). Isso é seguro mas confirme que o resto não mudou inadvertidamente.

---

## 3. Remover um usuário

1. Remover linha do `roles.json` (não basta — claim antigo continua válido até ser explicitamente sobrescrito ou o user ser deletado)
2. Ir no Console Firebase Auth → achar o usuário → menu (3 pontinhos) → "Excluir conta"
3. Confirmar a exclusão. O usuário deixa de existir no Firebase Auth e o claim some junto.

⚠️ O Firestore mantém todos os dados criados por ele (não há ownership por usuário no Mahau-sistema). Excluir o user só remove o login.

---

## 4. Atualizar Firestore Rules em produção

Rules são versionadas em `firestore.rules` no repo, mas a aplicação NÃO é automática — tem que ser manual no Console.

1. Abrir https://console.firebase.google.com/project/mahau-sistema/firestore/rules
2. Limpar editor (Ctrl+A, Delete)
3. Copiar conteúdo de `firestore.rules` do repo e colar
4. Clicar "Publicar"
5. Confirmar no modal
6. Testar como admin no app que tudo continua funcionando (Dashboard, Estoque, Eventos, Lixeira)

### Reverter

O Console mantém histórico de versões. Lateral esquerda mostra cada versão com timestamp. Clicar numa versão antiga e "Publicar" essa versão de novo restaura.

---

## 5. Renovar a service account key do Admin SDK

Necessário se:
- A key atual foi vazada/comprometida
- Está expirada (raro — keys do Firebase não expiram, mas podem ser revogadas manualmente)
- Você quer rotação periódica (boa prática a cada 6-12 meses)

1. Abrir https://console.firebase.google.com/project/mahau-sistema/settings/serviceaccounts/adminsdk
2. Clicar "Gerar nova chave privada"
3. Baixar o `.json` que vai pra Downloads
4. Mover pra raiz do projeto: `C:\Users\backs\Mahau-sistema\`
5. ⚠️ Verificar que o nome bate com `*-firebase-adminsdk-*.json` (default do Firebase já bate — é gitignored)
6. Rodar `git status --short` pra confirmar que o arquivo NÃO aparece como untracked (se aparecer, .gitignore está quebrado)
7. (Opcional) Apagar a key antiga do disco
8. (Opcional) Revogar a key antiga no Console: aba "Chaves" do service account → menu → Excluir

Depois disso, `set-claims.mjs` continua funcionando normalmente — ele acha qualquer `*-firebase-adminsdk-*.json` na pasta.

---

## Histórico de mudanças importantes

- **27/05/2026**: Migração do modelo "logado = admin" → RBAC com 3 papéis (admin/manager/staff). Custom claims via JWT, Firestore Rules atualizadas (v3). Commits: 23b63fb, a5a8078, 0ad6b4f, 2e7f5ce.
