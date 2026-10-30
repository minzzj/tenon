// 榫卯 V5 · IoT 接入模块入口
// Lead 的 server/lib/v2/index.js 加一行：{ dir:'iot', name:'iot', factory:'createIotService' }
import { createIotService, ROUTES, IOT_VERSION } from './manager.js';
import { HA_VERSION, createHomeAssistantClient, buildServiceRequest } from './homeassistant.js';
import { MQTT_VERSION, createMqttAdapter } from './mqtt.js';
import { SSDP_VERSION, ssdpDiscover, parseSsdpResponse } from './ssdp.js';

export { createIotService, ROUTES, IOT_VERSION, HA_VERSION, MQTT_VERSION, SSDP_VERSION, createHomeAssistantClient, createMqttAdapter, ssdpDiscover, parseSsdpResponse, buildServiceRequest };
export const routes = ROUTES;
export default createIotService;