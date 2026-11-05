import { useRef, useState } from 'react';
import { ApiError } from '../api';
import { Alert, AlertContent, AlertDescription, AlertIcon } from '../components/motion/alert';
import { Button } from '../components/motion/button';
import { type ImportResult, inventoryApi, inventoryMessageOf } from './inventory-api';
import { IMPORT_MAX_ROWS, parseProductsCsv, type ParsedCsv } from './csv';
import { checkFileSize, decodeTextFile, FILE_PROBLEM_MESSAGES } from './knowledge-rules';

export interface ImportCsvProps {
  readonly companyId: string;
  readonly settle: (error: unknown) => string | null;
  /** Recarrega a lista depois de importar. */
  readonly onImported: () => void;
}

const REASON_TEXT = {
  invalid: 'dados inválidos',
  duplicate_in_file: 'SKU repetido na planilha',
  sku_exists: 'SKU já existe (não foi alterado)',
  limit_reached: 'limite de 500 produtos atingido',
} as const;

function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('leitura'));
    };
    reader.onerror = () => reject(new Error('leitura'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Importação de produtos por CSV (spec 026, E4): o arquivo é lido e interpretado **no navegador** (colunas
 * `sku;nome;descricao;preco;quantidade`, separador `;` ou `,`, preço com vírgula) e enviado em JSON, até
 * 200 linhas. Só **cria** produtos: SKU que já existe é ignorado e reportado, sem alterar nada. O conteúdo
 * da planilha só vive em memória, nesta tela.
 */
export function ImportCsv({ companyId, settle, onImported }: ImportCsvProps) {
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ result: ImportResult; lines: readonly number[] } | null>(
    null,
  );
  const input = useRef<HTMLInputElement>(null);

  const choose = async (file: File | undefined): Promise<void> => {
    setParsed(null);
    setReport(null);
    setError(null);
    setFileProblem(null);
    if (file === undefined) return;
    const sizeProblem = checkFileSize(file.size);
    if (sizeProblem !== null) {
      setFileProblem(FILE_PROBLEM_MESSAGES[sizeProblem]);
      return;
    }
    try {
      const decoded = decodeTextFile(await readFile(file));
      if ('problem' in decoded) {
        setFileProblem(FILE_PROBLEM_MESSAGES[decoded.problem]);
        return;
      }
      setParsed(parseProductsCsv(decoded.text));
    } catch {
      setFileProblem(FILE_PROBLEM_MESSAGES['not-utf8']);
    }
  };

  const send = async (): Promise<void> => {
    if (parsed === null || parsed.rows.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await inventoryApi.importRows(
        companyId,
        parsed.rows.map((entry) => entry.row),
      );
      setReport({ result, lines: parsed.rows.map((entry) => entry.line) });
      setParsed(null);
      if (input.current !== null) input.current.value = '';
      onImported();
    } catch (failure) {
      const own = inventoryMessageOf(failure);
      const text = own ?? settle(failure);
      if (text !== null) {
        const known = own !== null || (failure instanceof ApiError && failure.status !== 400);
        setError(known ? text : 'Não foi possível importar agora. Tente de novo.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <p className="m-0 text-sm text-muted-foreground">
        Arquivo de texto (.csv) com as colunas <code>sku;nome;descricao;preco;quantidade</code>, até{' '}
        {IMPORT_MAX_ROWS} linhas. O preço pode ter vírgula (59,90). Só cria produtos novos: um SKU
        que já existe é ignorado.
      </p>
      <div className="grid gap-1">
        <label htmlFor="arquivo-csv" className="px-1 text-sm font-medium">
          Arquivo CSV
        </label>
        <input
          ref={input}
          id="arquivo-csv"
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          disabled={busy}
          onChange={(event) => void choose(event.target.files?.[0])}
          className="text-sm file:mr-3 file:rounded-xl file:border file:border-border file:bg-muted file:px-3 file:py-2 file:text-sm file:text-foreground"
        />
      </div>
      <div aria-live="polite" className="grid gap-2">
        {fileProblem !== null && (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">{fileProblem}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
        {error !== null && (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">{error}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
        {parsed !== null && parsed.tooMany && (
          <Alert variant="destructive">
            <AlertIcon />
            <AlertContent>
              <AlertDescription className="text-inherit">
                A planilha passa de {IMPORT_MAX_ROWS} linhas. Divida em arquivos menores.
              </AlertDescription>
            </AlertContent>
          </Alert>
        )}
        {parsed !== null && !parsed.tooMany && (
          <p className="m-0 text-sm">
            {parsed.rows.length} {parsed.rows.length === 1 ? 'linha pronta' : 'linhas prontas'} para
            importar
            {parsed.invalid.length > 0
              ? `; ${String(parsed.invalid.length)} com problema (linhas ${parsed.invalid.slice(0, 10).join(', ')}${parsed.invalid.length > 10 ? '…' : ''}) não serão enviadas`
              : ''}
            .
          </p>
        )}
        {report !== null && (
          <div className="grid gap-1 text-sm">
            <p className="m-0">
              <strong>{report.result.created}</strong>{' '}
              {report.result.created === 1 ? 'produto criado' : 'produtos criados'};{' '}
              <strong>{report.result.skipped.length}</strong> ignorados.
            </p>
            {report.result.skipped.length > 0 && (
              <ul className="m-0 list-disc pl-5 text-muted-foreground">
                {report.result.skipped.slice(0, 30).map((item) => (
                  <li key={item.row}>
                    Linha {report.lines[item.row - 1] ?? item.row}: {REASON_TEXT[item.reason]}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div>
        <Button
          disabled={busy || parsed === null || parsed.tooMany || parsed.rows.length === 0}
          onClick={() => void send()}
        >
          {busy ? 'Importando…' : 'Importar'}
        </Button>
      </div>
    </div>
  );
}
