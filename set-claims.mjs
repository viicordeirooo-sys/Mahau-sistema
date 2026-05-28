#!/usr/bin/env node
/*
 * set-claims.mjs — atribui custom claims de papel (role) aos usuários do Firebase Auth.
 * Mahau-sistema · ferramenta de administração (rodar localmente, NUNCA em produção).
 *
 * USO:
 *   node set-claims.mjs --dry-run   # mostra o que faria, sem alterar nada
 *   node set-claims.mjs             # aplica os claims
 *
 * PRÉ-REQUISITOS:
 *   1) npm install firebase-admin          (cria node_modules/, já gitignorado)
 *   2) Chave de service account no diretório. O script procura, nesta ordem:
 *        a) env GOOGLE_APPLICATION_CREDENTIALS  (caminho completo do .json)
 *        b) ./service-account-key.json
 *        c) o primeiro ./*-firebase-adminsdk-*.json do diretório
 *      (Os nomes default da chave já estão no .gitignore — nunca commitar.)
 *
 * PAPÉIS (claims):
 *   admin   -> { role: "admin" }
 *   manager -> { role: "manager" }
 *   staff   -> { role: "staff" }
 *
 * IMPORTANTE: após aplicar, cada usuário precisa DESLOGAR e LOGAR de novo
 * (ou aguardar ~1h) para o novo token carregar o claim.
 */

import admin from "firebase-admin";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT_ROLES propositalmente VAZIO: este script não chuta e-mails reais.
// Preencha o mapa  email -> { role }  criando um roles.json no mesmo diretório
// (tem prioridade sobre este objeto e é gitignorado, mantendo e-mails reais fora
// do repositório público — lembre: a raiz é servida publicamente pelo Vercel).
// Exemplo de roles.json:
//   { "socio@exemplo.com": { "role": "admin" }, "gerente@exemplo.com": { "role": "manager" } }
// Alternativamente, edite o objeto abaixo (mas NÃO commite e-mails reais).
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_ROLES = {};

const VALID_ROLES = ["admin", "manager", "staff"];

function loadRoles(){
  if(existsSync("roles.json")){
    try{
      const r = JSON.parse(readFileSync("roles.json","utf8"));
      console.log("Usando roles.json (override local).");
      return r;
    }catch(e){
      console.error("✗ roles.json inválido: "+e.message); process.exit(1);
    }
  }
  return DEFAULT_ROLES;
}

function validateRoles(roles){
  const errs=[];
  for(const [email, c] of Object.entries(roles)){
    if(!c || !VALID_ROLES.includes(c.role))
      errs.push(`${email}: role inválido (${JSON.stringify(c)}) — use ${VALID_ROLES.join("/")}`);
  }
  if(errs.length){ console.error("✗ Configuração inválida:\n  - "+errs.join("\n  - ")); process.exit(1); }
}

function findKeyFile(){
  if(process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if(existsSync("service-account-key.json")) return "service-account-key.json";
  const hit = readdirSync(".").find(f=>/-firebase-adminsdk-.*\.json$/.test(f));
  return hit || null;
}

// ── main ─────────────────────────────────────────────────────────────────────
const DRY = process.argv.includes("--dry-run");
const ROLES = loadRoles();
validateRoles(ROLES);

if(Object.keys(ROLES).length === 0){
  console.error("Nenhum papel configurado. Crie um roles.json (email -> { role }) ou edite DEFAULT_ROLES.");
  console.error('Exemplo roles.json: { "socio@exemplo.com": { "role": "admin" } }');
  process.exit(1);
}

const keyPath = findKeyFile();
if(!keyPath){
  console.error("✗ Chave de service account não encontrada.");
  console.error("  Defina GOOGLE_APPLICATION_CREDENTIALS, ou ponha service-account-key.json,");
  console.error("  ou um *-firebase-adminsdk-*.json neste diretório.");
  process.exit(1);
}

let svc;
try{ svc = JSON.parse(readFileSync(resolve(keyPath),"utf8")); }
catch(e){ console.error("✗ Falha ao ler a chave "+keyPath+": "+e.message); process.exit(1); }

admin.initializeApp({ credential: admin.credential.cert(svc) });
console.log(`Projeto: ${svc.project_id}  |  Chave: ${keyPath}  |  Modo: ${DRY?"DRY-RUN":"APLICANDO"}`);
console.log("─".repeat(64));

let ok=0, fail=0;
for(const [email, claims] of Object.entries(ROLES)){
  try{
    const user = await admin.auth().getUserByEmail(email);
    if(DRY){
      console.log(`• ${email}  ->  ${JSON.stringify(claims)}   (atual: ${JSON.stringify(user.customClaims||{})})`);
    }else{
      await admin.auth().setCustomUserClaims(user.uid, claims);
      const after = (await admin.auth().getUser(user.uid)).customClaims;
      console.log(`✓ ${email}  ->  ${JSON.stringify(after)}`);
    }
    ok++;
  }catch(e){
    fail++;
    if(e.code==="auth/user-not-found")
      console.error(`✗ ${email} — usuário não existe. Crie no Console (Authentication > Users) antes.`);
    else
      console.error(`✗ ${email} — ${e.code||""} ${e.message}`);
  }
}
console.log("─".repeat(64));
console.log(`Concluído: ${ok} ok, ${fail} falha(s).`);
if(!DRY && ok>0) console.log("⚠ Cada usuário precisa DESLOGAR e LOGAR de novo para o token carregar o claim.");
process.exit(fail ? 1 : 0);
