package com.minzzj.tenon

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

/**
 * 16kHz / 单声道 / PCM16 录音器（语音管家的输入）。
 * 开始后后台线程持续读取 PCM；停止时写入标准 WAV 头并返回文件。
 */
class VoiceRecorder(private val context: Context) {
    companion object {
        const val SAMPLE_RATE = 16000
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    }

    private var record: AudioRecord? = null
    private var worker: Thread? = null
    private var pcm: ByteArrayOutputStream? = null
    @Volatile private var recording = false
    @Volatile var maxAmplitude: Int = 0
        private set

    val isRecording: Boolean get() = recording

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (recording) return true
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minBuf <= 0) return false
        val bufSize = minBuf * 4
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, CHANNEL, ENCODING, bufSize)
        } catch (e: Exception) {
            LogBus.log("录音器创建失败：" + e.message)
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        record = rec
        pcm = ByteArrayOutputStream()
        maxAmplitude = 0
        recording = true
        try {
            rec.startRecording()
        } catch (e: Exception) {
            recording = false
            rec.release()
            record = null
            LogBus.log("开始录音失败：" + e.message)
            return false
        }
        worker = Thread {
            val buf = ShortArray(bufSize / 2)
            val bytes = ByteArray(bufSize)
            while (recording) {
                val n = try { rec.read(buf, 0, buf.size) } catch (_: Exception) { -1 }
                if (n <= 0) continue
                var amp = 0
                for (i in 0 until n) {
                    val v = buf[i].toInt()
                    val a = if (v < 0) -v else v
                    if (a > amp) amp = a
                    bytes[i * 2] = (v and 0xFF).toByte()
                    bytes[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
                }
                if (amp > maxAmplitude) maxAmplitude = amp
                pcm?.write(bytes, 0, n * 2)
            }
        }.also { it.isDaemon = true; it.start() }
        LogBus.log("开始录音（16kHz 单声道）")
        return true
    }

    /** 停止并返回 WAV 文件（无有效音频时返回 null）。 */
    fun stop(): File? {
        if (!recording) return null
        recording = false
        try { worker?.join(1200) } catch (_: InterruptedException) {}
        try { record?.stop() } catch (_: Exception) {}
        try { record?.release() } catch (_: Exception) {}
        record = null
        val data = pcm?.toByteArray() ?: ByteArray(0)
        pcm = null
        if (data.size < SAMPLE_RATE / 10) {
            LogBus.log("录音太短（" + data.size + " 字节），忽略")
            return null
        }
        val out = File(context.cacheDir, "tenon-voice-" + System.currentTimeMillis() + ".wav")
        FileOutputStream(out).use { fos ->
            fos.write(wavHeader(data.size))
            fos.write(data)
        }
        LogBus.log("录音完成：" + out.name + "（" + data.size + " 字节）")
        return out
    }

    fun cancel() {
        recording = false
        try { worker?.join(800) } catch (_: InterruptedException) {}
        try { record?.stop() } catch (_: Exception) {}
        try { record?.release() } catch (_: Exception) {}
        record = null
        pcm = null
    }

    private fun wavHeader(dataSize: Int): ByteArray {
        val totalSize = dataSize + 36
        val byteRate = SAMPLE_RATE * 2
        val h = ByteArray(44)
        fun putStr(off: Int, s: String) { for (i in s.indices) h[off + i] = s[i].code.toByte() }
        fun putInt(off: Int, v: Int) {
            h[off] = (v and 0xFF).toByte()
            h[off + 1] = ((v shr 8) and 0xFF).toByte()
            h[off + 2] = ((v shr 16) and 0xFF).toByte()
            h[off + 3] = ((v shr 24) and 0xFF).toByte()
        }
        fun putShort(off: Int, v: Int) {
            h[off] = (v and 0xFF).toByte()
            h[off + 1] = ((v shr 8) and 0xFF).toByte()
        }
        putStr(0, "RIFF"); putInt(4, totalSize); putStr(8, "WAVE")
        putStr(12, "fmt "); putInt(16, 16); putShort(20, 1); putShort(22, 1)
        putInt(24, SAMPLE_RATE); putInt(28, byteRate); putShort(32, 2); putShort(34, 16)
        putStr(36, "data"); putInt(40, dataSize)
        return h
    }
}
