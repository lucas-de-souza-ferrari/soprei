import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from './api';
import type { AttentionFilter } from './contracts';

/** Telas do admin. A navegação fica só em memória: nada de id, filtro ou busca na barra de endereço. */
export type View =
  | { readonly name: 'overview' }
  | {
      readonly name: 'companies';
      readonly status?: 'active' | 'suspended';
      readonly attention?: AttentionFilter;
    }
  | { readonly name: 'company'; readonly companyId: string; readonly from: View }
  | { readonly name: 'accounts' }
  | { readonly name: 'billing' }
  | { readonly name: 'channel' }
  | { readonly name: 'health' };

export interface AdminContextValue {
  readonly api: ApiClient;
  readonly navigate: (view: View) => void;
  /** Chamado em qualquer 401: a sessão acabou, volta à tela Entrar. */
  readonly expire: () => void;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (value === null) throw new Error('AdminContext ausente');
  return value;
}

export interface Loaded<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  readonly reload: () => void;
}

/**
 * Carrega um dado ao montar (e quando `key` muda), com "Atualizar" manual. Um 401 encerra a sessão; o
 * resultado de uma carga antiga (troca de filtro no meio) é descartado.
 */
export function useLoad<T>(load: (api: ApiClient) => Promise<T>, key: string): Loaded<T> {
  const { api, expire } = useAdmin();
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({
    loading: true,
  });
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => {
    const mine = ++generation.current;
    setState((previous) => ({ ...previous, loading: true, error: undefined }));
    loadRef.current(api).then(
      (data) => {
        if (mine === generation.current) setState({ data, loading: false });
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        if (error instanceof ApiError && error.status === 401) return expire();
        setState((previous) => ({ data: previous.data, error, loading: false }));
      },
    );
  }, [api, expire]);

  useEffect(() => {
    setState({ loading: true });
    reload();
    return () => {
      generation.current++;
    };
  }, [reload, key]);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}

export interface PageResult<T> {
  readonly items: readonly T[] | null;
  readonly nextCursor: string | null;
}

export interface Paged<T> {
  /** `null`: a rota respondeu `items: null` (cobrança desligada). */
  readonly items: readonly T[] | null | undefined;
  readonly hasMore: boolean;
  readonly error: unknown;
  readonly loading: boolean;
  readonly reload: () => void;
  readonly more: () => void;
}

/** Lista paginada por cursor: "Atualizar" recomeça, "Carregar mais" acrescenta a página seguinte. */
export function usePaged<T>(
  load: (api: ApiClient, cursor: string | null) => Promise<PageResult<T>>,
  key: string,
): Paged<T> {
  const { api, expire } = useAdmin();
  const [state, setState] = useState<{
    items?: readonly T[] | null;
    cursor: string | null;
    error?: unknown;
    loading: boolean;
  }>({ cursor: null, loading: true });
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const fetchPage = useCallback(
    (cursor: string | null, previous: readonly T[] | null | undefined) => {
      const mine = ++generation.current;
      setState((current) => ({ ...current, loading: true, error: undefined }));
      loadRef.current(api, cursor).then(
        (page) => {
          if (mine !== generation.current) return;
          const items =
            page.items === null
              ? null
              : [...(cursor === null ? [] : (previous ?? [])), ...page.items];
          setState({ items, cursor: page.nextCursor, loading: false });
        },
        (error: unknown) => {
          if (mine !== generation.current) return;
          if (error instanceof ApiError && error.status === 401) return expire();
          setState((current) => ({ ...current, error, loading: false }));
        },
      );
    },
    [api, expire],
  );

  const reload = useCallback(() => fetchPage(null, undefined), [fetchPage]);

  useEffect(() => {
    setState({ cursor: null, loading: true });
    reload();
    return () => {
      generation.current++;
    };
  }, [reload, key]);

  return {
    items: state.items,
    hasMore: state.cursor !== null && state.items !== null,
    error: state.error,
    loading: state.loading,
    reload,
    more: () => {
      if (state.cursor !== null) fetchPage(state.cursor, state.items);
    },
  };
}
