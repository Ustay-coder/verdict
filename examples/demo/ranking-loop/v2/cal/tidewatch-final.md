# Tidewatch

Tidewatch texts residents of streets next to small creeks when the storm drain outside is about to overflow. Those streets flood within minutes after heavy rain, Regional flood warnings cover whole districts and arrive by app; none warns a single street from its own drain.

**How it works:** an ESP32 with an ultrasonic sensor sits on a storm drain and sends the water level over one LoRa link to a gateway. A FastAPI service waits for 2 readings in a row above the threshold, then sends an SMS through Twilio. A Leaflet map shows every reading.

**What we tested:** the sensor ran for 20 hours on a real creek. Two test alerts reached 4 phones, about 40 seconds after the reading.

**Built during the hackathon:** the SMS alert service, the 2-reading threshold rule, the map dashboard and a 3D-printed enclosure. **Existed before:** the sensor firmware, from our earlier open-source university project, and the ESP32 board and sensor.

**AI tools:** Claude Code wrote most of the map dashboard's frontend code.

Demo (2:40): https://video.example.org/tidewatch-demo · Code: https://git.example.org/tidewatch

**What doesn't work yet:** there is one sensor and no mesh; the threshold is fixed, with no forecasting; the battery lasts about 2 days; and we have no city permit to mount sensors on public drains.
