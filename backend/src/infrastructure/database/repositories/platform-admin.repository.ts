import type {
  NewPlatformAdmin,
  PlatformAdmin,
  PlatformAdminCredentials,
  PlatformAdminId,
  PlatformAdminRepository,
} from '../../../domain/index.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import type { TenantScopedDb } from '../extensions/tenant-scope.js';
import { toPlatformAdmin } from './mappers.js';
import { withRepositoryErrors } from './repository-errors.js';

/**
 * Operadores da plataforma (spec 007): model global, sem `companyId`. O hash da senha e o segredo
 * TOTP cifrado (spec 044) saem apenas em `findCredentialsByEmail` e `findTotpSecret`.
 */
export class PrismaPlatformAdminRepository implements PlatformAdminRepository {
  constructor(private readonly db: TenantScopedDb) {}

  findCredentialsByEmail(email: string): Promise<PlatformAdminCredentials | null> {
    return withRepositoryErrors('PlatformAdmin.findCredentialsByEmail', async () => {
      const row = await this.db.platformAdmin.findFirst({ where: { email } });
      return row === null
        ? null
        : {
            admin: toPlatformAdmin(row),
            passwordHash: row.passwordHash,
            totpSecretCiphertext: row.totpSecretCiphertext,
          };
    });
  }

  findById(id: PlatformAdminId): Promise<PlatformAdmin> {
    return withRepositoryErrors('PlatformAdmin.findById', async () => {
      const row = await this.db.platformAdmin.findFirst({ where: { id } });
      if (row === null) throw notFound();
      return toPlatformAdmin(row);
    });
  }

  create(data: NewPlatformAdmin): Promise<PlatformAdmin> {
    return withRepositoryErrors('PlatformAdmin.create', async () => {
      const row = await this.db.platformAdmin.create({
        data: { email: data.email, passwordHash: data.passwordHash },
      });
      return toPlatformAdmin(row);
    });
  }

  updatePassword(id: PlatformAdminId, passwordHash: string): Promise<void> {
    return withRepositoryErrors('PlatformAdmin.updatePassword', async () => {
      const { count } = await this.db.platformAdmin.updateMany({
        where: { id },
        data: { passwordHash },
      });
      if (count === 0) throw notFound();
    });
  }

  findTotpSecret(id: PlatformAdminId): Promise<string | null> {
    return withRepositoryErrors('PlatformAdmin.findTotpSecret', async () => {
      const row = await this.db.platformAdmin.findFirst({
        where: { id },
        select: { totpSecretCiphertext: true },
      });
      if (row === null) throw notFound();
      return row.totpSecretCiphertext;
    });
  }

  setTotpSecret(id: PlatformAdminId, ciphertext: string | null): Promise<void> {
    return withRepositoryErrors('PlatformAdmin.setTotpSecret', async () => {
      const { count } = await this.db.platformAdmin.updateMany({
        where: { id },
        data: { totpSecretCiphertext: ciphertext, totpLastStep: null },
      });
      if (count === 0) throw notFound();
    });
  }

  claimTotpStep(id: PlatformAdminId, step: number): Promise<boolean> {
    return withRepositoryErrors('PlatformAdmin.claimTotpStep', async () => {
      // Um UPDATE condicional: duas requisições com o mesmo código, ao mesmo tempo, não entram as duas.
      const { count } = await this.db.platformAdmin.updateMany({
        where: {
          id,
          totpSecretCiphertext: { not: null },
          OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
        },
        data: { totpLastStep: step },
      });
      return count === 1;
    });
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('Administrador não encontrado', {
    context: { entity: 'PlatformAdmin' },
  });
}
