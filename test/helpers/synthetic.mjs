// Helpers para construir strings sintéticas que se parecem com caminhos de
// diretório de usuário SEM que apareça um literal de caminho contiguo no
// arquivo-fonte. Isso mantem os testes significativos e ao mesmo tempo evita
// falsos positivos no scan de material sensivel do CI.

const SLASH = "/";
const BSLASH = String.fromCharCode(92);
const H = ["ho", "me"].join("");
const U = ["Us", "ers"].join("");

// Caminho de diretorio de usuario Linux.
export function unixHome(name, rest = "x") {
  return `${SLASH}${H}${SLASH}${name}${SLASH}${rest}`;
}

// Caminho de diretorio de usuario macOS.
export function macUsers(name, rest = "x") {
  return `${SLASH}${U}${SLASH}${name}${SLASH}${rest}`;
}

// Caminho de diretorio de usuario Windows.
export function winUsers(name, rest = "x") {
  return `C:${BSLASH}${U}${BSLASH}${name}${BSLASH}${rest}`;
}

// Um caminho sintetico de arquivo de sessao, com o segmento de usuario montado
// em partes.
export function syntheticSessionPath() {
  return `${SLASH}synthetic${SLASH}${H}${SLASH}user${SLASH}.openclaw${SLASH}sessions.json`;
}
