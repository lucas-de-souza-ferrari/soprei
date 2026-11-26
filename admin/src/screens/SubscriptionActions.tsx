import { useState } from 'react';
import { PLAN_CODES, type AccountDetail, type PlanCode } from '../contracts';
import { label } from '../format';
import { Button, Select } from '../ui';
import { ActionDialog, TextInput, type ActionSpec } from './CompanyActions';

type SubscriptionAction = 'trial' | 'extend' | 'modules' | 'plan' | 'cancel' | 'reactivate' | 'end';

/** Quais ações a assinatura admite agora (o servidor confere de novo as regras). */
export function availableSubscriptionActions(
  subscription: AccountDetail['subscription'],
): SubscriptionAction[] {
  if (subscription === null) return ['trial'];
  const paid = subscription.status !== 'TRIAL' && subscription.access !== 'blocked';
  const actions: SubscriptionAction[] = ['extend', 'modules', 'plan'];
  if (paid) actions.push(subscription.cancelAtPeriodEnd ? 'reactivate' : 'cancel');
  if (subscription.access !== 'blocked') actions.push('end');
  return actions;
}

const BUTTONS: Record<SubscriptionAction, string> = {
  trial: 'Iniciar teste',
  extend: 'Conceder dias',
  modules: 'Módulos',
  plan: 'Trocar plano',
  cancel: 'Cancelar no fim do período',
  reactivate: 'Desfazer cancelamento',
  end: 'Encerrar agora',
};

function Checkbox({
  label: text,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4"
      />
      <span>{text}</span>
    </label>
  );
}

/**
 * Ações do admin sobre a assinatura da conta (spec 045, E4): iniciar teste, conceder dias, módulos, trocar
 * plano, cancelar ou desfazer o cancelamento no fim do período e encerrar agora (com o código novo do
 * autenticador). Nenhuma mexe em dinheiro: a renovação seguinte cobra o que estiver ligado, e a pessoa vê o
 * preço na tela de Assinatura antes de pagar.
 */
export function SubscriptionActions({
  detail,
  onDone,
}: {
  readonly detail: AccountDetail;
  readonly onDone: () => void;
}) {
  const subscription = detail.subscription;
  const [current, setCurrent] = useState<SubscriptionAction | null>(null);
  const [days, setDays] = useState('30');
  const [agenda, setAgenda] = useState(false);
  const [stock, setStock] = useState(false);
  const [plan, setPlan] = useState<PlanCode>('ESSENTIAL');
  const base = `/platform/accounts/${encodeURIComponent(detail.id)}/subscription`;
  if (!detail.billingEnabled) return null;

  function open(action: SubscriptionAction) {
    setDays('30');
    setAgenda(subscription?.modules.schedule ?? false);
    setStock(subscription?.modules.inventory ?? false);
    setPlan(subscription?.plan.code ?? 'ESSENTIAL');
    setCurrent(action);
  }

  const daysNumber = Number(days);
  const specs: Record<SubscriptionAction, ActionSpec> = {
    trial: {
      title: 'Iniciar o teste gratuito?',
      effect:
        'A conta ganha o teste gratuito (plano Essencial com Agenda e Estoque) e as empresas em que ela é dona e ainda não têm assinatura passam a usá-lo. Uma vez por conta.',
      confirm: 'Iniciar teste',
      danger: false,
      code: false,
      path: `${base}/trial`,
      kind: 'trial',
    },
    extend: {
      title: 'Conceder dias?',
      effect:
        'Os dias são somados ao fim do período (ou do teste), a partir de hoje se já venceu. Uma assinatura vencida ou em carência volta a ativa. O uso já contado no mês continua contando. Nada é cobrado.',
      confirm: 'Conceder dias',
      danger: false,
      code: false,
      path: `${base}/extend`,
      body: { days: daysNumber },
      kind: 'extend',
      ready: Number.isInteger(daysNumber) && daysNumber >= 1 && daysNumber <= 90,
      fields: (
        <TextInput
          label="Dias (1 a 90)"
          name="days"
          value={days}
          onChange={(value) => setDays(value.replace(/\D/g, '').slice(0, 2))}
          maxLength={2}
        />
      ),
    },
    modules: {
      title: 'Mudar os módulos?',
      effect:
        'Vale na hora, sem cobrança agora. A renovação seguinte cobra o que estiver ligado; a pessoa vê o preço na tela de Assinatura antes de pagar.',
      confirm: 'Salvar módulos',
      danger: false,
      code: false,
      path: `${base}/modules`,
      body: { agenda, stock },
      kind: 'modules',
      ready:
        agenda !== (subscription?.modules.schedule ?? false) ||
        stock !== (subscription?.modules.inventory ?? false),
      fields: (
        <>
          <Checkbox label="Agenda" checked={agenda} onChange={setAgenda} />
          <Checkbox label="Estoque" checked={stock} onChange={setStock} />
        </>
      ),
    },
    plan: {
      title: 'Trocar o plano?',
      effect:
        'Vale na hora, no mesmo ciclo, sem cobrança agora, e apaga a troca agendada pela pessoa. A renovação seguinte cobra o plano novo. Um plano que não comporta as empresas da conta é recusado.',
      confirm: 'Trocar plano',
      danger: false,
      code: false,
      path: `${base}/plan`,
      body: { planCode: plan },
      kind: 'plan',
      ready: plan !== subscription?.plan.code,
      fields: (
        <Select<PlanCode>
          label="Plano novo"
          value={plan}
          onChange={setPlan}
          options={PLAN_CODES.map((key) => [key, label(key)] as const)}
        />
      ),
    },
    cancel: {
      title: 'Cancelar no fim do período?',
      effect:
        subscription?.access === 'grace'
          ? 'A assinatura está na carência (o período pago já acabou): cancelar agora encerra o acesso na hora, sem esperar o fim da carência. Dá para desfazer enquanto ela não for paga de novo.'
          : 'A assinatura segue ativa até o fim do período pago e depois encerra, sem carência. Dá para desfazer antes disso.',
      confirm: 'Cancelar no fim do período',
      danger: true,
      code: false,
      path: `${base}/cancel`,
      kind: 'cancel',
    },
    reactivate: {
      title: 'Desfazer o cancelamento?',
      effect: 'A assinatura volta a renovar normalmente no fim do período.',
      confirm: 'Desfazer cancelamento',
      danger: false,
      code: false,
      path: `${base}/reactivate`,
      kind: 'reactivate',
    },
    end: {
      title: 'Encerrar a assinatura agora?',
      effect:
        'A assinatura vence agora, sem carência: o atendimento de todas as empresas da conta para. O histórico de pedidos e de uso fica guardado. Para voltar, conceda dias ou a pessoa paga de novo.',
      confirm: 'Encerrar agora',
      danger: true,
      code: true,
      path: `${base}/end`,
      kind: 'end',
    },
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {availableSubscriptionActions(subscription).map((name) => (
          <Button
            key={name}
            variant={name === 'end' || name === 'cancel' ? 'danger' : 'secondary'}
            onClick={() => open(name)}
          >
            {BUTTONS[name]}
          </Button>
        ))}
      </div>
      <ActionDialog
        key={current ?? 'fechado'}
        spec={current === null ? null : specs[current]}
        onClose={() => setCurrent(null)}
        onDone={onDone}
      />
    </div>
  );
}
