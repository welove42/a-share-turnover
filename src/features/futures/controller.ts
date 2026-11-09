import { CommoditiesController } from '../commodities/controller';

// Share quote rendering/polling, but keep this view's configuration, cache and pause state independent.
class FuturesController extends CommoditiesController {
  constructor(
    context,
    options: Omit<NonNullable<ConstructorParameters<typeof CommoditiesController>[1]>, 'section'> = {}
  ) {
    super(context, { ...options, section: 'futures' });
  }
}
export { FuturesController };
