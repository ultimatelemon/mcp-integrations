import type { NsPriceV2 } from '../ns/types.ts';
import { compact, euros } from './util.ts';

export function formatPrice(price: NsPriceV2) {
  const total = euros(price.totalPriceInCents);
  const diff = euros(price.priceDifferenceInCentsBetweenFirstAndSecondClass);
  const first = price.travelClass === 'FIRST_CLASS';
  return compact({
    priceEur: total,
    travelClass: first ? 1 : 2,
    otherClassPriceEur:
      total !== undefined && diff !== undefined
        ? Math.round((first ? total - diff : total + diff) * 100) / 100
        : undefined,
    jointJourneyDiscountEur: euros(
      price.priceDifferenceInCentsBetweenJointJourneyDiscount
    ),
    discount:
      price.travelDiscount && price.travelDiscount !== 'NO_DISCOUNT'
        ? price.travelDiscount
        : undefined,
    products: price.travelProducts,
    operator: price.operatorName
  });
}
