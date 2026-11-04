import { randomUUID } from 'node:crypto';
import { CompanyId } from '../domain/index.js';
import { describeInvitationRepositoryContract } from './company-invitation-repository-contract.js';
import { InMemoryInvitationRepository } from './in-memory-invitation.repository.js';

// O mesmo contrato roda no Postgres em `company-invitation.repository.integration.test.ts`.
describeInvitationRepositoryContract('em memória', () =>
  Promise.resolve({
    repository: new InMemoryInvitationRepository(),
    companyA: CompanyId.parse(randomUUID()),
    companyB: CompanyId.parse(randomUUID()),
    inviterA: randomUUID(),
    acceptedA: randomUUID(),
    inviterB: randomUUID(),
  }),
);
