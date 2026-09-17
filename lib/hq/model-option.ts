/**
 * One row in a picker: a model, a repo, or an API provider preset. Kept free
 * of React so server code can build options.
 */
export type ModelOption = {
  id: string;
  name: string;
  /** Group heading the row appears under. */
  provider: string;
  /** Key into the provider icon set, when the row has a known logo. */
  providerId?: string;
  description?: string;
  badge?: string;
  keywords?: readonly string[];
  disabled?: boolean;
};
