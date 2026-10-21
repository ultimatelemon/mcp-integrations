import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import yazl from 'yazl';

const { transit_realtime: rt } = GtfsRealtimeBindings;

/** Builds a zip in memory from file name → CSV lines. */
export function zipOf(files: Record<string, string[]>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, lines] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(lines.join('\r\n') + '\r\n'), name);
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    zip.outputStream.on('error', reject);
  });
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;

/*
 * A tiny OVapi-shaped feed: GVB metro 52 Noord → Station Zuid and back every
 * 10 minutes from 09:02, ferry F3 Centraal Station → Buiksloterweg every 6
 * minutes from 09:00, plus a tram and another agency's metro that must be
 * left out, and one 52 trip after midnight (25:05) on the 6 October service day.
 */
export function gvbFeed(): Record<string, string[]> {
  const trips = [
    'route_id,service_id,trip_id,realtime_trip_id,trip_headsign,direction_id'
  ];
  const stopTimes = [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type'
  ];
  const north = ['m-noord', 'm-noorderpark', 'm-cs', 'm-zuid'];
  for (let i = 0; i < 6; i++) {
    const start = 9 * 60 + 2 + i * 10;
    trips.push(
      `52,wk,52s${String(i)},GVB:52:${String(100 + i)},Station Zuid,0`
    );
    north.forEach((stop, seq) => {
      stopTimes.push(
        `52s${String(i)},${hhmm(start + seq * 3)},${hhmm(start + seq * 3)},${stop},${String(seq + 1)},0`
      );
    });
    trips.push(`52,wk,52n${String(i)},GVB:52:${String(200 + i)},Noord,1`);
    [...north].reverse().forEach((stop, seq) => {
      stopTimes.push(
        `52n${String(i)},${hhmm(start + seq * 3)},${hhmm(start + seq * 3)},${stop},${String(seq + 1)},0`
      );
    });
    const ferry = 9 * 60 + i * 6;
    trips.push(`F3,wk,f3-${String(i)},,Buiksloterweg,0`);
    stopTimes.push(`f3-${String(i)},${hhmm(ferry)},${hhmm(ferry)},f-cs,1,0`);
    stopTimes.push(
      `f3-${String(i)},${hhmm(ferry + 5)},${hhmm(ferry + 5)},f-bsw,2,0`
    );
  }
  trips.push('52,wk,52late,,Station Zuid,0');
  stopTimes.push(
    '52late,25:02:00,25:02:00,m-noorderpark,1,0',
    '52late,25:05:00,25:05:00,m-cs,2,0',
    '52late,25:08:00,25:08:00,m-zuid,3,0'
  );
  trips.push('26,wk,tram1,,IJburg,0', 'RET-A,wk,ret1,,Binnenhof,0');
  stopTimes.push(
    'tram1,09:05:00,09:05:00,m-cs,1,0',
    'tram1,09:15:00,09:15:00,t-ijburg,2,0',
    'ret1,09:05:00,09:05:00,r-1,1,0',
    'ret1,09:15:00,09:15:00,r-2,2,0'
  );

  return {
    'agency.txt': [
      'agency_id,agency_name,agency_url,agency_timezone',
      'GVB,GVB,https://gvb.nl,Europe/Amsterdam',
      'RET,RET,https://ret.nl,Europe/Amsterdam'
    ],
    'routes.txt': [
      'route_id,agency_id,route_short_name,route_long_name,route_type',
      '52,GVB,52,Noord - Station Zuid,1',
      'F3,GVB,F3,"Centraal Station - Buiksloterweg, veer",4',
      '26,GVB,26,IJburg,0',
      'RET-A,RET,A,Schiedam - Binnenhof,1'
    ],
    'trips.txt': trips,
    'stop_times.txt': stopTimes,
    'stops.txt': [
      'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code',
      'm-noord,"Amsterdam, Noord",52.4010,4.9330,0,,1',
      'm-noorderpark,"Amsterdam, Noorderpark",52.3900,4.9200,0,,2',
      'm-cs,"Amsterdam, Centraal Station",52.3780,4.9000,0,,3',
      'm-zuid,"Amsterdam, Station Zuid",52.3390,4.8720,0,,1',
      'f-cs,"Amsterdam, Centraal Station",52.3810,4.9010,0,,',
      'f-bsw,"Amsterdam, Buiksloterweg",52.3830,4.9030,0,,',
      't-ijburg,"Amsterdam, IJburg",52.35,4.99,0,,',
      'r-1,"Rotterdam, Binnenhof",51.9,4.4,0,,'
    ],
    'calendar_dates.txt': [
      'service_id,date,exception_type',
      'wk,20261006,1',
      'wk,20261007,1'
    ]
  };
}

/** Realtime: the 09:12 metro to Station Zuid is 2 minutes late from Noord on, the 09:22 is cancelled. */
export function gvbRealtime(): Uint8Array {
  return rt.FeedMessage.encode(
    rt.FeedMessage.create({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1_791_270_000 },
      entity: [
        {
          id: '1',
          tripUpdate: {
            // The feed may carry the realtime_trip_id rather than the static one.
            trip: { tripId: 'GVB:52:101', startDate: '20261006' },
            stopTimeUpdate: [
              { stopSequence: 1, stopId: 'm-noord', departure: { delay: 120 } }
            ]
          }
        },
        {
          id: '2',
          tripUpdate: {
            trip: {
              tripId: '52s2',
              startDate: '20261006',
              scheduleRelationship:
                rt.TripDescriptor.ScheduleRelationship.CANCELED
            },
            stopTimeUpdate: []
          }
        },
        {
          id: '3',
          tripUpdate: {
            trip: { tripId: 'some-bus' },
            stopTimeUpdate: [{ stopSequence: 1, departure: { delay: 60 } }]
          }
        }
      ]
    })
  ).finish();
}
