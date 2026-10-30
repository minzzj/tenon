package com.minzzj.tenon

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * V5 提醒后台兜底：WorkManager 每 15 分钟拉一次 /api/v2/reminders/pending 并弹本地通知。
 * Android 14 规则：WorkManager 最小周期 15 分钟，前台 30s 即时轮询由 MainActivity 负责。
 */
class ReminderWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        return try {
            val n = ReminderNotifier.pollPending(applicationContext)
            if (n >= 0) Result.success() else Result.retry()
        } catch (e: Exception) {
            LogBus.log("提醒 Worker 失败：" + (e.message ?: ""))
            Result.retry()
        }
    }

    companion object {
        private const val UNIQUE_NAME = "tenon-reminder-poll"

        fun schedule(context: Context) {
            try {
                val req = PeriodicWorkRequestBuilder<ReminderWorker>(15, TimeUnit.MINUTES).build()
                WorkManager.getInstance(context)
                    .enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
            } catch (e: Exception) {
                LogBus.log("WorkManager 调度失败：" + (e.message ?: ""))
            }
        }
    }
}
