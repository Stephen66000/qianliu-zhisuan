import { vi } from "vitest";

export const useBillingRulesMock = vi.fn();
export const modelsMock = vi.fn();
export const resourcesMock = vi.fn();
export const routesMock = vi.fn();
export const principalsMock = vi.fn();
export const policiesMock = vi.fn();
export const readyRoutesMock = vi.fn();
export const providersMock = vi.fn();
export const postMock = vi.fn();
export const patchMock = vi.fn();
export const invalidateMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useBillingRules: () => useBillingRulesMock(),
  useDispatchPolicies: () => policiesMock(),
  usePricingReadyRoutes: () => readyRoutesMock() ?? query({ routes: [] }),
  useUnifiedModels: () => modelsMock(),
  useProviderResources: () => resourcesMock(),
  useModelRoutes: () => routesMock(),
  usePrincipals: () => principalsMock(),
  useProviders: () => providersMock() ?? query({ providers: [] }),
  QUERY_KEYS: {
    billingRules: ["billing-rules"],
    dispatchPolicies: ["dispatch-policies"],
    unifiedModels: ["unified-models"],
    modelRoutes: (id: string) => ["model-routes", id],
    providers: ["providers"],
  },
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    post: (...args: unknown[]) => postMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateMock }),
    useMutation: (options: {
      mutationFn: (value: unknown) => Promise<unknown>;
      onSuccess?: () => void;
    }) => ({
      mutate: async (value: unknown) => {
        await options.mutationFn(value);
        options.onSuccess?.();
      },
      isPending: false,
      error: null,
    }),
  };
});

export function query(data: Record<string, unknown>) {
  return { data, error: null, isLoading: false, refetch: vi.fn() };
}
