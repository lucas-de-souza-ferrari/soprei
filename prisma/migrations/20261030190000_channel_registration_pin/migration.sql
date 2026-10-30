-- Spec 015b: PIN de registro do número (Embedded Signup), guardado CIFRADO como o token.
-- Migration ADITIVA: uma coluna anulável nova; nada é apagado nem reescrito. Conexões existentes
-- (PUT manual) ficam com o PIN nulo.
ALTER TABLE "channel_connections" ADD COLUMN "registration_pin_ciphertext" TEXT;
