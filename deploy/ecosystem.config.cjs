// PM2 do Soprei (spec 037). Versionado, sem segredo: os segredos ficam só no .env de cada ambiente
// (o dotenv lê o .env do diretório atual, por isso o `cwd` de cada app é o backend do ambiente).
// Aplicado pelo deploy/deploy.sh com `pm2 startOrReload`.
//
// kill_timeout (D7): maior que o SHUTDOWN_TIMEOUT_MS padrão (60 000 ms, spec 034) para o PM2 nunca
// mandar SIGKILL no meio de um desligamento que o sistema ainda considera dentro do prazo. Se o .env
// de um ambiente definir SHUTDOWN_TIMEOUT_MS maior que o padrão, suba este valor junto (5 s a mais).
const SHUTDOWN_TIMEOUT_MS = 60_000;
const KILL_TIMEOUT_MS = SHUTDOWN_TIMEOUT_MS + 5_000;

module.exports = {
  apps: [
    {
      name: 'soprei-api',
      script: 'dist/index.js',
      cwd: '/var/www/soprei/backend',
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: KILL_TIMEOUT_MS,
      max_memory_restart: '1G',
      env: {},
    },
    {
      name: 'soprei-staging',
      script: 'dist/index.js',
      cwd: '/var/www/soprei-staging/backend',
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: KILL_TIMEOUT_MS,
      // Menor que o da produção de propósito: se algo for sacrificado por falta de memória, o staging.
      max_memory_restart: '700M',
      env: {
        // Autoridade privada do Mailpit do staging (D4): o certificado continua sendo verificado.
        NODE_EXTRA_CA_CERTS: '/etc/soprei-staging/mailpit-ca.pem',
      },
    },
  ],
};
