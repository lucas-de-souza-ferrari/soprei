import { useState } from 'react';
import { Button } from '../components/motion/button';
import { Modal } from '../company/Modal';
import { SalesContactForm } from './SalesContactForm';

/**
 * Cartão Enterprise da aba Planos (spec 040, D10): não é um plano selecionável (nada de rádio, nada de preço
 * calculado); só abre o formulário de contato comercial num `Modal`. Aparece com o checkout ligado ou não.
 */
export function EnterpriseCard() {
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-labelledby="enterprise-titulo"
      className="grid min-w-0 gap-2 rounded-xl border border-border p-4 text-sm"
      data-testid="cartao-enterprise"
    >
      <h3 id="enterprise-titulo" className="m-0 text-base font-semibold">
        Enterprise
      </h3>
      <p className="m-0 font-medium">Sob consulta</p>
      <p className="m-0 text-muted-foreground">
        Para redes, franquias e operações com mais de 10 empresas ou mais de 30 mil respostas por
        mês.
      </p>
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Falar com a gente
        </Button>
      </div>
      <Modal open={open} title="Falar com a gente" onClose={() => setOpen(false)}>
        <SalesContactForm autoFocus />
      </Modal>
    </section>
  );
}
