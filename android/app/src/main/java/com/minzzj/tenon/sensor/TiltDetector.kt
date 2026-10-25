package com.minzzj.tenon.sensor

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import java.util.ArrayDeque
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * 「手机往前一倾，页面滑到电脑」的手势检测（v2.1 超级终端）：
 * - TYPE_ACCELEROMETER + 低通滤波求重力方向；
 * - 前倾角 pitch = atan2(-z, sqrt(x^2+y^2))：竖屏握持 ≈ 0°，顶部向前下方倾倒 → 90°；
 * - 判定：pitch >= 阈值（默认 25°）且 1.2s 窗口内变化 >= 15° → 触发一次；2s 冷却防抖。
 */
class TiltDetector(
    context: Context,
    private val thresholdDeg: Int = 25,
    private val onTiltForward: (Float) -> Unit
) : SensorEventListener {

    private val sensorManager =
        context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val gravity = FloatArray(3)
    private var initialized = false
    private var running = false
    private val history = ArrayDeque<FloatArray>() // [timestampMs, pitchDeg]
    private var lastTriggerAt = 0L

    private val minDeltaDeg = 15f
    private val cooldownMs = 2000L
    private val windowMs = 1200L

    val available: Boolean
        get() = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null

    fun start() {
        if (running || !available) return
        val sensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        initialized = false
        history.clear()
        running = true
        sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
    }

    fun stop() {
        if (!running) return
        running = false
        sensorManager.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent) {
        val alpha = 0.85f // 低通滤波：保留 85% 历史重力
        if (!initialized) {
            for (i in 0..2) gravity[i] = event.values[i]
            initialized = true
            return
        }
        for (i in 0..2) gravity[i] = alpha * gravity[i] + (1 - alpha) * event.values[i]

        val horizontal = sqrt(gravity[0] * gravity[0] + gravity[1] * gravity[1])
        val pitch = Math.toDegrees(
            atan2(-gravity[2].toDouble(), horizontal.toDouble())
        ).toFloat()

        val now = System.currentTimeMillis()
        history.addLast(floatArrayOf(now.toFloat(), pitch))
        while (history.isNotEmpty() && now - history.peekFirst()[0].toLong() > windowMs) {
            history.removeFirst()
        }
        val base = history.peekFirst()?.get(1) ?: pitch
        if (pitch >= thresholdDeg && abs(pitch - base) >= minDeltaDeg && now - lastTriggerAt > cooldownMs) {
            lastTriggerAt = now
            history.clear()
            onTiltForward(pitch)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
