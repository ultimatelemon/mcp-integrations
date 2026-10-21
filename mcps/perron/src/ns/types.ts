/*
 * Response shapes for the fields perron reads, derived from specs/ and checked
 * against real responses. Everything is optional: NS leaves fields out freely.
 */

export interface NsStationV3 {
  id: { uicCode: string; code: string; evaCode?: string };
  stationType?: string;
  names: { long: string; medium?: string; short?: string; synonyms?: string[] };
  location?: { lat: number; lng: number };
  tracks?: string[];
  hasKnownFacilities?: boolean;
  availableForAccessibleTravel?: boolean;
  hasTravelAssistance?: boolean;
  country?: string;
}

export interface NsMessage {
  id?: string;
  head?: string;
  text?: string;
  lead?: string;
  type?: string;
}

export interface NsNote {
  value?: string;
  key?: string;
  noteType?: string;
  isPresentationRequired?: boolean;
}

export interface NsTransferMessage {
  message?: string;
  type?: string;
}

export interface NsProduct {
  number?: string;
  categoryCode?: string;
  shortCategoryName?: string;
  longCategoryName?: string;
  operatorName?: string;
  type?: string;
}

export interface NsTripStop {
  name?: string;
  stationCode?: string;
  uicCode?: string;
  type?: string;
  plannedDateTime?: string;
  actualDateTime?: string;
  plannedTrack?: string;
  actualTrack?: string;
  cancelled?: boolean;
  notes?: NsNote[];
}

export interface NsLegStop {
  name?: string;
  uicCode?: string;
  passing?: boolean;
  cancelled?: boolean;
  plannedArrivalDateTime?: string;
  actualArrivalDateTime?: string;
  plannedDepartureDateTime?: string;
  actualDepartureDateTime?: string;
  plannedArrivalTrack?: string;
  actualArrivalTrack?: string;
  plannedDepartureTrack?: string;
  actualDepartureTrack?: string;
}

export interface NsLeg {
  name?: string;
  travelType?: string;
  direction?: string;
  cancelled?: boolean;
  partCancelled?: boolean;
  alternativeTransport?: boolean;
  changePossible?: boolean;
  shorterStock?: boolean;
  crowdForecast?: string;
  origin: NsTripStop;
  destination: NsTripStop;
  product?: NsProduct;
  messages?: NsMessage[];
  notes?: NsNote[];
  transferMessages?: NsTransferMessage[];
  plannedDurationInMinutes?: number;
  stops?: NsLegStop[];
}

export interface NsTripFare {
  priceInCents?: number;
  buyableTicketPriceInCents?: number;
  supplementInCents?: number;
  product?: string;
  travelClass?: string;
}

export interface NsTrip {
  status?: string;
  transfers?: number;
  plannedDurationInMinutes?: number;
  actualDurationInMinutes?: number;
  crowdForecast?: string;
  ctxRecon?: string;
  routeId?: string;
  productFare?: NsTripFare;
  fareOptions?: { isInternational?: boolean; isTotalPriceUnknown?: boolean };
  messages?: NsMessage[];
  legs: NsLeg[];
}

export interface NsTripsResponse {
  trips?: NsTrip[];
  message?: string;
}

export interface NsPriceV2 {
  totalPriceInCents?: number;
  priceDifferenceInCentsBetweenFirstAndSecondClass?: number;
  priceDifferenceInCentsBetweenJointJourneyDiscount?: number;
  operatorName?: string;
  travelDiscount?: string;
  travelClass?: string;
  travelProducts?: string[];
}

export interface NsBoardMessage {
  message?: string;
  style?: string;
}

export interface NsBoardEntry {
  direction?: string;
  origin?: string;
  name?: string;
  plannedDateTime?: string;
  actualDateTime?: string;
  plannedTrack?: string;
  actualTrack?: string;
  product?: NsProduct;
  trainCategory?: string;
  cancelled?: boolean;
  routeStations?: { mediumName?: string; uicCode?: string }[];
  messages?: NsBoardMessage[];
  departureStatus?: string;
  arrivalStatus?: string;
}

export interface NsStation {
  name?: string;
  uicCode?: string;
  countryCode?: string;
}

export interface NsArrivalOrDeparture {
  product?: NsProduct;
  origin?: NsStation;
  destination?: NsStation;
  plannedTime?: string;
  actualTime?: string;
  delayInSeconds?: number;
  plannedTrack?: string;
  actualTrack?: string;
  cancelled?: boolean;
  crowdForecast?: string;
}

export interface NsStock {
  trainType?: string;
  numberOfSeats?: number;
  numberOfParts?: number;
  trainParts?: { stockIdentifier?: string; facilities?: string[] }[];
}

export interface NsJourneyStop {
  id?: string;
  stop: NsStation;
  destination?: string;
  status?: string;
  kind?: string;
  arrivals?: NsArrivalOrDeparture[];
  departures?: NsArrivalOrDeparture[];
  actualStock?: NsStock;
  plannedStock?: NsStock;
}

export interface NsJourney {
  notes?: NsNote[];
  productNumbers?: string[];
  stops?: NsJourneyStop[];
}

export interface NsDisruptionStation {
  stationCode?: string;
  name?: string;
}

export interface NsTimespan {
  start?: string;
  end?: string;
  period?: string;
  situation?: { label?: string };
  cause?: { label?: string };
  additionalTravelTime?: { label?: string; shortLabel?: string };
  alternativeTransport?: { label?: string; shortLabel?: string };
  advices?: string[];
}

export interface NsAlternativeTransportTimespan {
  start?: string;
  end?: string;
  alternativeTransport?: {
    label?: string;
    shortLabel?: string;
    location?: { station?: NsDisruptionStation; description?: string }[];
  };
}

export interface NsDisruption {
  id: string;
  /** DISRUPTION, MAINTENANCE or CALAMITY. */
  type: string;
  title?: string;
  isActive?: boolean;
  start?: string;
  end?: string;
  period?: string | null;
  phase?: { label?: string };
  impact?: { value?: number };
  expectedDuration?: { description?: string; endTime?: string };
  summaryAdditionalTravelTime?: { label?: string; shortLabel?: string };
  publicationSections?: {
    section?: { stations?: NsDisruptionStation[]; direction?: string };
    consequence?: { description?: string; level?: string };
  }[];
  timespans?: NsTimespan[];
  alternativeTransportTimespans?: NsAlternativeTransportTimespan[];
  // Calamities
  description?: string;
  priority?: string;
  lastUpdated?: string;
  expectedNextUpdate?: string;
  url?: string;
}

export interface NsTrainPart {
  materieelnummer?: number;
  type?: string;
  faciliteiten?: string[];
  zitplaatsen?: {
    zitplaatsEersteKlas?: number;
    zitplaatsTweedeKlas?: number;
    klapstoelEersteKlas?: number;
    klapstoelTweedeKlas?: number;
    fietsplekken?: number;
  };
  eindbestemming?: string;
  bakken?: { drukte?: string }[];
}

export interface NsTrainInfo {
  ritnummer?: number;
  station?: string;
  type?: string;
  vervoerder?: string;
  spoor?: string;
  materieeldelen?: NsTrainPart[];
  ingekort?: boolean;
  lengte?: number;
  lengteInMeters?: number;
  rijrichting?: string;
}

export interface NsPrognose {
  prognoses?: {
    trainNumber?: number;
    stationUic?: string;
    date?: string;
    classification?: string;
  }[];
}

export interface NsOpeningHours {
  dayOfWeek: number;
  startTime?: string;
  endTime?: string;
  closesNextDay?: boolean;
}

export interface NsPlaceLocation {
  name?: string;
  description?: string;
  stationCode?: string;
  open?: string;
  openingHours?: NsOpeningHours[];
  nextOpeningTime?: string;
  extra?: Record<string, string>;
  street?: string;
  houseNumber?: string;
  city?: string;
}

export interface NsPlaceGroup {
  type?: string;
  name?: string;
  identifiers?: string[];
  locations?: NsPlaceLocation[];
}

export interface NsPlacesResponse {
  payload?: NsPlaceGroup[];
}

export interface NsLift {
  id?: string;
  name?: string;
  stationCode?: string;
  open?: string;
  statusLabel?: string;
  platform?: string;
}
