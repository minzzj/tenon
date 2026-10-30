import io
p = r"H:\minzzj文件\技术部\项目\官方\榫卯\public\super-v4.js"
s = io.open(p, encoding="utf-8").read()

def rep(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit("ANCHOR FAIL [%s]: %d" % (label, n))
    s = s.replace(old, new)

# 1) fillIot：真实配置形状（顶层 ha/mqtt；mqtt 字段是 url）
rep("""    var cfg = (S.iot.config && (S.iot.config.config || S.iot.config)) || {};
    var ha = cfg.homeassistant || cfg.ha || {};
    var mq = cfg.mqtt || {};
    if ($('iot-ha-url')) $('iot-ha-url').value = ha.baseUrl || cfg.baseUrl || '';
    if ($('iot-ha-token')) $('iot-ha-token').value = '';
    if ($('iot-ha-token')) $('iot-ha-token').placeholder = ha.tokenMasked || ha.token || cfg.tokenMasked ? '已保存令牌（保存后脱敏）' : 'HA 个人资料 → 长期访问令牌';
    if ($('iot-mqtt-broker')) $('iot-mqtt-broker').value = mq.broker || cfg.mqttBroker || '';
    if ($('iot-mqtt-prefix')) $('iot-mqtt-prefix').value = mq.prefix || cfg.prefix || 'homeassistant';
    if ($('iot-mqtt-username')) $('iot-mqtt-username').value = mq.username || '';
    if ($('iot-mqtt-password')) $('iot-mqtt-password').value = '';""",
"""    var cfg = (S.iot.config && (S.iot.config.config || S.iot.config)) || {};
    var ha = cfg.ha || cfg.homeassistant || {};
    var mq = cfg.mqtt || {};
    if ($('iot-ha-url')) $('iot-ha-url').value = ha.baseUrl || cfg.baseUrl || '';
    if ($('iot-ha-token')) $('iot-ha-token').value = '';
    if ($('iot-ha-token')) $('iot-ha-token').placeholder = (ha.tokenSet || ha.tokenMasked) ? '已保存令牌（保存后脱敏，留空不覆盖）' : 'HA 个人资料 → 长期访问令牌';
    if ($('iot-mqtt-broker')) $('iot-mqtt-broker').value = mq.url || mq.broker || cfg.mqttUrl || '';
    if ($('iot-mqtt-prefix')) $('iot-mqtt-prefix').value = mq.prefix || cfg.prefix || 'homeassistant';
    if ($('iot-mqtt-username')) $('iot-mqtt-username').value = mq.username || '';
    if ($('iot-mqtt-password')) $('iot-mqtt-password').value = '';""", "fillIot")

# 2) renderIotStatus：真实 status 形状（ha.lastTestOk / mqtt.connected / devices.total）
rep("""    var st = S.iot.status || {};
    var ha = st.ha || st.homeassistant || {};
    var mq = st.mqtt || {};
    var haOn = !!(ha.connected || ha.ok) || st.haConnected === true;
    var mqOn = !!(mq.connected || mq.ok) || st.mqttConnected === true;
    var haChip = $('iot-ha-state'); if (haChip) { haChip.textContent = haOn ? 'HA 已连接' : (ha.configured || st.haConfigured ? 'HA 未连接' : 'HA 未配置'); haChip.classList.toggle('on', haOn); }
    var mqChip = $('iot-mqtt-state'); if (mqChip) { mqChip.textContent = mqOn ? 'MQTT 已连接' : (mq.configured || st.mqttConfigured ? 'MQTT 未连接' : 'MQTT 未配置'); mqChip.classList.toggle('on', mqOn); }
    var cnt = st.devices != null ? st.devices : (st.deviceCount != null ? st.deviceCount : (S.iot.devices || []).length);
    var chipIot = $('chip-iot'); if (chipIot) chipIot.textContent = '物联 ' + (Number(cnt) || 0);
    var dc = $('iot-devices-count'); if (dc) dc.textContent = String((S.iot.devices || []).length || Number(cnt) || 0);""",
"""    var st = S.iot.status || {};
    var ha = st.ha || {};
    var mq = st.mqtt || {};
    var haOn = ha.lastTestOk === true && ha.configured !== false;
    var mqOn = mq.connected === true;
    var haChip = $('iot-ha-state');
    if (haChip) { haChip.textContent = haOn ? 'HA 已连接' : (ha.configured ? 'HA 未连接' : 'HA 未配置'); haChip.classList.toggle('on', !!haOn); }
    var mqChip = $('iot-mqtt-state');
    if (mqChip) { mqChip.textContent = mqOn ? 'MQTT 已连接' : (mq.configured ? 'MQTT 未连接' : 'MQTT 未配置'); mqChip.classList.toggle('on', !!mqOn); }
    var total = (st.devices && typeof st.devices === 'object') ? (st.devices.total || 0) : (st.devices || st.deviceCount || (S.iot.devices || []).length);
    var chipIot = $('chip-iot'); if (chipIot) chipIot.textContent = '物联 ' + (Number(total) || 0);
    var dc = $('iot-devices-count'); if (dc) dc.textContent = String((S.iot.devices || []).length || Number(total) || 0);""", "renderIotStatus")

# 3) iotConfigBody：真实 PATCH 形状 {ha:{baseUrl,token}, mqtt:{url,username,password,prefix}}；留空不覆盖
rep("""  function iotConfigBody(which) {
    var body = {};
    if (which === 'ha') {
      body.baseUrl = $('iot-ha-url') ? $('iot-ha-url').value.trim() : '';
      body.token = $('iot-ha-token') ? $('iot-ha-token').value.trim() : '';
      body.homeassistant = { baseUrl: body.baseUrl, token: body.token };
    } else {
      var mq = {
        broker: $('iot-mqtt-broker') ? $('iot-mqtt-broker').value.trim() : '',
        username: $('iot-mqtt-username') ? $('iot-mqtt-username').value.trim() : '',
        password: $('iot-mqtt-password') ? $('iot-mqtt-password').value : '',
        prefix: $('iot-mqtt-prefix') ? $('iot-mqtt-prefix').value.trim() : 'homeassistant'
      };
      body.mqtt = mq; body.prefix = mq.prefix; body.mqttBroker = mq.broker;
    }
    return body;
  }""",
"""  function iotConfigBody(which) {
    var body = {};
    if (which === 'ha') {
      var ha = { baseUrl: $('iot-ha-url') ? $('iot-ha-url').value.trim() : '' };
      var token = $('iot-ha-token') ? $('iot-ha-token').value.trim() : '';
      if (token) ha.token = token; // 留空则不覆盖已保存令牌
      body.ha = ha;
    } else {
      var mq = {
        url: $('iot-mqtt-broker') ? $('iot-mqtt-broker').value.trim() : '',
        username: $('iot-mqtt-username') ? $('iot-mqtt-username').value.trim() : '',
        prefix: $('iot-mqtt-prefix') ? $('iot-mqtt-prefix').value.trim() : 'homeassistant'
      };
      var pw = $('iot-mqtt-password') ? $('iot-mqtt-password').value : '';
      if (pw) mq.password = pw;
      body.mqtt = mq;
    }
    return body;
  }""", "iotConfigBody")

# 4) saveIot：保存后刷新配置显示
rep("""    var r = await api('PATCH', '/api/v2/iot/config', iotConfigBody(which));
    if (r.ok) { toast('已保存' + (which === 'ha' ? ' Home Assistant 配置' : ' MQTT 配置'), 'ok'); loadIotStatus(); }""",
"""    var r = await api('PATCH', '/api/v2/iot/config', iotConfigBody(which));
    if (r.ok) { toast('已保存' + (which === 'ha' ? ' Home Assistant 配置' : ' MQTT 配置'), 'ok'); await fillIot(); }""", "saveIot")

# 5) MQTT 发现：真实接口 /iot/mqtt/devices
rep("""      var r = await softApi('GET', '/api/v2/iot/discover?source=mqtt');
      if (isMissing(r) || !r.ok) { toast('发现失败：请先保存 MQTT 配置并测试连接（或后端尚未支持）', 'warn', 4800); return; }
      S.iot.mqttDiscovered = (r.data && (r.data.devices || r.data.items)) || [];""",
"""      var r = await softApi('GET', '/api/v2/iot/mqtt/devices');
      if (isMissing(r) || !r.ok) { toast('发现失败：请先保存 MQTT 配置并测试连接（或后端尚未支持）', 'warn', 4800); return; }
      S.iot.mqttDiscovered = (r.data && (r.data.devices || r.data.items)) || [];""", "mqtt-discover")

# 6) import 成功数量（真实 imported 是数字）
rep("""    var r = await api('POST', '/api/v2/iot/import', { source: 'ha', ids: ids });
    if (r.ok) { toast('已导入 ' + ((r.data && (r.data.imported || []).length) || ids.length) + ' 个设备', 'ok'); loadIotDevices(); loadIotStatus(); }
    else toast('导入失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');""",
"""    var r = await api('POST', '/api/v2/iot/import', { source: 'ha', ids: ids });
    if (r.ok) { toast('已导入 ' + importedCount(r.data, ids.length) + ' 个设备', 'ok'); loadIotDevices(); loadIotStatus(); }
    else toast('导入失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');""", "import-ha")

rep("""    var r = await api('POST', '/api/v2/iot/import', { source: source, ids: ids });
    if (r.ok) { toast('已导入 ' + ids.length + ' 个设备', 'ok'); loadIotDevices(); loadIotStatus(); }
    else toast('导入失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');""",
"""    var r = await api('POST', '/api/v2/iot/import', { source: source, ids: ids });
    if (r.ok) { toast('已导入 ' + importedCount(r.data, ids.length) + ' 个设备', 'ok'); loadIotDevices(); loadIotStatus(); }
    else toast('导入失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');""", "import-iot")

# 7) 新增 importedCount 辅助（放在 importIot 前）
rep("""  async function importIot(source, ids) {""",
"""  function importedCount(data, fallback) {
    if (!data) return fallback;
    var v = data.imported;
    if (typeof v === 'number') return v;
    if (Array.isArray(v)) return v.length;
    if (Array.isArray(data.devices)) return data.devices.length;
    return fallback;
  }
  async function importIot(source, ids) {""", "importedCount")

# 8) 设备卡：按真实 commands 生成控制按钮（并显示 source/available）
OLD_DEV = """    box.innerHTML = S.iot.devices.map(function (d) {
      var domain = d.domain || d.type || 'switch';
      var on = /on|playing|open|true/i.test(String(d.state));
      var controls = [];
      if (domain === 'light') { controls = [['开', 'turn_on'], ['关', 'turn_off'], ['亮度+', 'brightness_up']]; }
      else if (domain === 'switch' || domain === 'socket') { controls = [['开', 'turn_on'], ['关', 'turn_off'], ['切换', 'toggle']]; }
      else if (domain === 'media_player') { controls = [['播放', 'media_play'], ['暂停', 'media_pause']]; }
      else if (domain === 'cover') { controls = [['打开', 'open_cover'], ['关闭', 'close_cover']]; }
      else if (domain === 'climate') { controls = [['开', 'turn_on'], ['关', 'turn_off']]; }
      else if (domain === 'sensor') { controls = []; }
      else { controls = [['开', 'turn_on'], ['关', 'turn_off']]; }
      return '<div class="device iot-device" data-id="' + esc(d.id) + '" data-testid="iot-device">' +
        '<h3><span class="dot ' + (on ? 'on' : '') + '"></span>' + esc(d.name || d.id) + ' <span class="badge">' + esc(domain) + (d.source === 'mqtt' ? ' · MQTT' : d.source === 'ssdp' ? ' · SSDP' : d.source === 'ha' ? ' · HA' : '') + '</span></h3>' +
        '<div class="meta">状态：' + esc(on ? '开' : (d.state || '未知')) + (d.online === false ? ' · 离线' : '') + '</div>' +
        '<div class="acts">' + controls.map(function (c) { return '<button data-ctl="' + esc(c[1]) + '" data-id="' + esc(d.id) + '" data-testid="iot-control">' + esc(c[0]) + '</button>'; }).join('') +
        '<button class="danger" data-iot-del="' + esc(d.id) + '" data-testid="iot-delete">移除</button></div>' +
        '</div>';
    }).join('');"""
NEW_DEV = """    box.innerHTML = S.iot.devices.map(function (d) {
      var domain = d.domain || d.type || 'switch';
      var on = /on|playing|open|true/i.test(String(d.state));
      var cmds = Array.isArray(d.commands) && d.commands.length ? d.commands : (Array.isArray(d.capabilities) ? d.capabilities.map(function (c) { return (c && c.command) || (c && c.id) || c; }).filter(Boolean) : []);
      var labelMap = { turn_on: '开', turn_off: '关', toggle: '切换', set_brightness: '亮度', brightness_up: '亮度+', brightness_down: '亮度-', media_play: '播放', media_pause: '暂停', media_next: '下一首', media_previous: '上一首', open_cover: '打开', close_cover: '关闭', set_temperature: '设温', read: '只读' };
      var controls = cmds.filter(function (c) { return c && c !== 'read'; }).slice(0, 3).map(function (c) { return [labelMap[c] || String(c), c]; });
      if (!controls.length && ['light', 'switch', 'socket'].indexOf(domain) >= 0) controls = [['开', 'turn_on'], ['关', 'turn_off']];
      var sourceLabel = d.source === 'mqtt' ? ' · MQTT' : d.source === 'ssdp' ? ' · SSDP' : d.source === 'ha' ? ' · HA' : '';
      return '<div class="device iot-device" data-id="' + esc(d.id) + '" data-testid="iot-device">' +
        '<h3><span class="dot ' + (on ? 'on' : '') + '"></span>' + esc(d.name || d.id) + ' <span class="badge">' + esc(domain) + sourceLabel + '</span></h3>' +
        '<div class="meta">状态：' + esc(on ? '开' : (d.state || '未知')) + (d.available === false ? ' · 不可用' : '') + (d.note ? ' · ' + esc(String(d.note).slice(0, 40)) : '') + '</div>' +
        '<div class="acts">' + (d.adapter === 'ssdp' ? '<span class="badge warn">SSDP 只读发现</span>' : '') + controls.map(function (c) { return '<button data-ctl="' + esc(c[1]) + '" data-id="' + esc(d.id) + '" data-testid="iot-control">' + esc(c[0]) + '</button>'; }).join('') +
        '<button class="danger" data-iot-del="' + esc(d.id) + '" data-testid="iot-delete">移除</button></div>' +
        '</div>';
    }).join('');"""
rep(OLD_DEV, NEW_DEV, "iot-device-card")

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("super-v4.js iot aligned ->", len(s))
