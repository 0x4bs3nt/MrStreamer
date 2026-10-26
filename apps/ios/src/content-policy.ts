import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import { adultIn } from "@mrstreamer/core/adult";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";

const policies = new WeakMap<OnDemandCatalogue, ReturnType<typeof classify>>();

function classify(catalogue: OnDemandCatalogue) {
  const movieAdult = adultIn(catalogue.movieCategories);
  const seriesAdult = adultIn(catalogue.seriesCategories);
  const movie = new Set(catalogue.movies.filter(movieAdult).map(({ id }) => id));
  const series = new Set(catalogue.series.filter(seriesAdult).map(({ id }) => id));
  return {
    movie,
    series,
    known: {
      movie: new Set(catalogue.movies.map(({ id }) => id)),
      series: new Set(catalogue.series.map(({ id }) => id)),
    },
    catalogue: {
      ...catalogue,
      movies: catalogue.movies.filter(({ id }) => !movie.has(id)),
      series: catalogue.series.filter(({ id }) => !series.has(id)),
    },
  };
}

/**
 * Public iOS catalogues exclude recognised provider flags and category names before indexing.
 * The raw lists stay intact for restored references and action admission. Unclassified provider
 * data is not a guarantee that content is adult-free. Desktop policy and personal copies stay
 * with their existing owners.
 */
export function titlePolicy(catalogue: OnDemandCatalogue) {
  const known = policies.get(catalogue);
  if (known) return known;
  const policy = classify(catalogue);
  policies.set(catalogue, policy);
  return policy;
}

/** A saved reference is excluded when all its versions are recognised, or its saved flag is. */
export function excludedSaved(
  catalogue: OnDemandCatalogue | null,
  saved: {
    readonly kind: TitleKind;
    readonly versionIds: readonly string[];
    readonly adult: boolean;
  },
): boolean {
  if (!catalogue) return saved.adult;
  const policy = titlePolicy(catalogue);
  const listed = saved.versionIds.filter((id) => policy.known[saved.kind].has(id));
  return listed.length > 0 ? listed.every((id) => policy[saved.kind].has(id)) : saved.adult;
}
