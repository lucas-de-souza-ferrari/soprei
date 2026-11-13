import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import type { Entitlements } from './billing-api';
import { accessNotice, MODULE_LABELS, type ContractModuleName } from './billing-rules';

/**
 * Faixa de estado da assinatura para QUALQUER papel (spec 031, E4): carência, assinatura encerrada ou cota
 * esgotada. Leitura continua funcionando; o texto diz como resolver (o titular abre a Assinatura; os demais
 * falam com ele). Sem leitura do acesso (cobrança desligada) não aparece nada. O limite de uso da IA aparece
 * só como texto genérico, sem números (spec 040, E2).
 */
export function AccessNotice({
  entitlements,
  holder,
  onOpenSubscription,
}: {
  readonly entitlements: Entitlements | null;
  readonly holder: boolean;
  readonly onOpenSubscription: () => void;
}) {
  const notice = accessNotice(entitlements, holder);
  if (notice === null) return null;
  return (
    <Alert variant={notice.tone === 'error' ? 'destructive' : 'warning'}>
      <AlertIcon />
      <AlertContent>
        <p className="m-0 font-semibold">{notice.title}</p>
        <AlertDescription className="text-inherit">{notice.text}</AlertDescription>
        {holder && (
          <div className="pt-2">
            <Button variant="outline" size="sm" onClick={onOpenSubscription}>
              Abrir Assinatura
            </Button>
          </div>
        )}
      </AlertContent>
    </Alert>
  );
}

/**
 * Tela de um módulo não contratado (Agenda ou Estoque): aparece no lugar da tela (que nem é montada, então
 * nenhuma chamada de escrita acontece) quando alguém força o endereço, e no passo do assistente.
 */
export function ModuleInvite({
  module,
  holder,
  onOpenSubscription,
}: {
  readonly module: ContractModuleName;
  readonly holder: boolean;
  readonly onOpenSubscription: () => void;
}) {
  const label = MODULE_LABELS[module];
  return (
    <div
      className="grid gap-3 rounded-2xl border border-border bg-card p-4 text-card-foreground"
      data-testid="modulo-nao-contratado"
    >
      <h2 className="m-0 text-lg font-semibold">{label} não contratado</h2>
      <p className="m-0 text-sm text-muted-foreground">
        O módulo {label} não faz parte da assinatura atual. Os dados que já existem continuam
        guardados e voltam a aparecer ao contratar o módulo.
      </p>
      {holder ? (
        <div>
          <Button onClick={onOpenSubscription}>Contratar na Assinatura</Button>
        </div>
      ) : (
        <p className="m-0 text-sm">Fale com a pessoa titular da conta para contratar o módulo.</p>
      )}
    </div>
  );
}
