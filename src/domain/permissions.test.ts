import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { USER_ROLES } from './entities/user.js';
import { canManageRole, hasPermission, PERMISSIONS, ROLE_PERMISSIONS } from './permissions.js';

describe('matriz papel -> permissão (snapshot da spec 008)', () => {
  it('ROLE_PERMISSIONS entrega a cada papel exatamente a matriz aprovada', () => {
    assert.deepEqual(ROLE_PERMISSIONS, {
      OWNER: [
        'conversation:read',
        'conversation:simulate',
        'user:read',
        'user:manage',
        'audit:read',
      ],
      ADMIN: [
        'conversation:read',
        'conversation:simulate',
        'user:read',
        'user:manage',
        'audit:read',
      ],
      AGENT: ['conversation:read', 'conversation:simulate'],
      VIEWER: ['conversation:read'],
    });
    assert.deepEqual([...USER_ROLES], ['OWNER', 'ADMIN', 'AGENT', 'VIEWER']);
    assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), [...USER_ROLES].sort());
  });

  it('toda permissão listada em PERMISSIONS é de algum papel e nenhuma sobra no mapa', () => {
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flat());
    assert.deepEqual([...granted].sort(), [...PERMISSIONS].sort());
  });

  it('hasPermission confere a matriz inteira', () => {
    for (const role of USER_ROLES) {
      for (const permission of PERMISSIONS) {
        assert.equal(
          hasPermission(role, permission),
          ROLE_PERMISSIONS[role].includes(permission),
          `${role} ${permission}`,
        );
      }
    }
  });

  it('papel fora de USER_ROLES nunca concede nada (inclusive nomes do protótipo do objeto)', () => {
    for (const role of [
      'SUPERADMIN',
      'owner',
      '',
      undefined,
      null,
      42,
      {},
      'constructor',
      '__proto__',
      'toString',
    ]) {
      for (const permission of PERMISSIONS) {
        assert.equal(hasPermission(role, permission), false, JSON.stringify(role));
      }
    }
  });
});

describe('hierarquia canManageRole', () => {
  const table: readonly (readonly [string, string, boolean])[] = [
    ['OWNER', 'OWNER', true],
    ['OWNER', 'ADMIN', true],
    ['OWNER', 'AGENT', true],
    ['OWNER', 'VIEWER', true],
    ['ADMIN', 'OWNER', false],
    ['ADMIN', 'ADMIN', false],
    ['ADMIN', 'AGENT', true],
    ['ADMIN', 'VIEWER', true],
    ['AGENT', 'OWNER', false],
    ['AGENT', 'ADMIN', false],
    ['AGENT', 'AGENT', false],
    ['AGENT', 'VIEWER', false],
    ['VIEWER', 'OWNER', false],
    ['VIEWER', 'AGENT', false],
    ['VIEWER', 'VIEWER', false],
  ];

  for (const [actor, target, expected] of table) {
    it(`${actor} ${expected ? 'gerencia' : 'não gerencia'} ${target}`, () => {
      assert.equal(canManageRole(actor, target), expected);
    });
  }

  it('papel desconhecido, de qualquer lado, não gerencia nem é gerenciado', () => {
    for (const unknown of ['ROOT', '', undefined, null, 'owner']) {
      assert.equal(canManageRole(unknown, 'AGENT'), false);
      assert.equal(canManageRole('OWNER', unknown), false);
      assert.equal(canManageRole('ADMIN', unknown), false);
    }
  });
});
