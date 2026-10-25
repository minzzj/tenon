package com.minzzj.tenon

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Camera
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import com.google.zxing.BinaryBitmap
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/** 扫码配对：Camera1 预览 + zxing-core 本地解码（不引入相机第三方库）。 */
class ScanActivity : Activity(), SurfaceHolder.Callback {
    companion object {
        private const val REQ_CAMERA = 2001
    }

    private lateinit var surface: SurfaceView
    private lateinit var hint: TextView
    private var camera: Camera? = null
    private var previewSize: Camera.Size? = null

    @Volatile
    private var decoding = false
    private val main = Handler(Looper.getMainLooper())
    private val reader = QRCodeReader()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this)
        root.setBackgroundColor(Ui.BG)
        surface = SurfaceView(this)
        root.addView(surface, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        hint = TextView(this).apply {
            text = "对准电脑端「配对」页显示的二维码"
            textSize = 16f
            setTextColor(Ui.PAPER)
            gravity = Gravity.CENTER
            setBackgroundColor(0xCC070B14.toInt())
        }
        root.addView(hint, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(64), Gravity.TOP))
        val close = TextView(this).apply {
            text = "关闭"
            textSize = 16f
            setTextColor(Ui.CYAN)
            setPadding(dp(20), dp(14), dp(20), dp(14))
            setOnClickListener { finish() }
        }
        root.addView(close, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM or Gravity.END))
        setContentView(root)
        surface.holder.addCallback(this)
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun surfaceCreated(holder: SurfaceHolder) = startPreview(holder)

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

    override fun surfaceDestroyed(holder: SurfaceHolder) = stopPreview()

    private fun startPreview(holder: SurfaceHolder) {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return
        if (camera != null) return
        try {
            val cam = Camera.open() ?: return
            camera = cam
            val params = cam.parameters
            val sizes = params.supportedPreviewSizes
            if (sizes == null || sizes.isEmpty()) {
                hint.text = "相机不支持预览"
                return
            }
            val size = sizes.firstOrNull { it.width <= 1280 && it.height <= 960 } ?: sizes[0]
            previewSize = size
            params.setPreviewSize(size.width, size.height)
            try {
                params.focusMode = Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
            } catch (_: Exception) {
            }
            cam.parameters = params
            cam.setPreviewDisplay(holder)
            cam.setPreviewCallback { data, c -> decodeFrame(data, c) }
            cam.startPreview()
            LogBus.log("相机预览已启动 ${size.width}x${size.height}")
        } catch (e: Exception) {
            LogBus.log("相机启动失败：${e.message}")
            hint.text = "相机不可用：${e.message}"
        }
    }

    private fun decodeFrame(data: ByteArray?, cam: Camera) {
        if (data == null || decoding) return
        val size = previewSize ?: return
        decoding = true
        try {
            val source = PlanarYUVLuminanceSource(
                data, size.width, size.height, 0, 0, size.width, size.height, false)
            val bitmap = BinaryBitmap(HybridBinarizer(source))
            val result = reader.decode(bitmap)
            val text = result.text
            main.post { onQr(text) }
        } catch (_: NotFoundException) {
        } catch (_: Exception) {
        } finally {
            main.postDelayed({ decoding = false }, 250)
        }
    }

    private fun onQr(text: String) {
        LogBus.log("扫码成功：${text.take(120)}")
        setResult(RESULT_OK, Intent().putExtra("qr", text))
        finish()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CAMERA) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startPreview(surface.holder)
            } else {
                hint.text = "未授权相机权限，无法扫码"
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (surface.holder.surface?.isValid == true) startPreview(surface.holder)
    }

    override fun onPause() {
        super.onPause()
        stopPreview()
    }

    private fun stopPreview() {
        try {
            camera?.setPreviewCallback(null)
            camera?.stopPreview()
            camera?.release()
        } catch (_: Exception) {
        }
        camera = null
    }
}