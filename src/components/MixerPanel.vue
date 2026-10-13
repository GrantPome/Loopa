<script setup lang="ts">
/**
 * 混音台（Mixer）
 * 每条轨道一个通道条：电平表 + 音量推子 + 声像 + 三段均衡 + 混响发送 + M/S
 * 最右侧为总线通道：总音量、混响返回、限幅阈值、总线电平表与限幅指示灯
 */
import { computed } from 'vue'
import type { Track } from '@/types'
import { EQ_BANDS, EQ_MAX, EQ_MIN, LIMITER_MAX, LIMITER_MIN } from '@/types'
import { gainToDbText } from '@/utils/audio'
import {
  resetTrackMix,
  selectTrack,
  setLimiterThreshold,
  setMasterVolume,
  setReverbWet,
  setTrackEq,
  setTrackPan,
  setTrackReverbSend,
  setTrackVolume,
  state,
  toggleMute,
  toggleSolo
} from '@/core/store'

const tracks = computed(() => state.project.tracks)

/** 电平 0~1 转成百分比高度（做一次开方，让小音量也看得见变化） */
function levelPercent(level: number): number {
  return Math.min(100, Math.sqrt(Math.max(0, level)) * 100)
}

function onVolumeInput(track: Track, event: Event): void {
  setTrackVolume(track.id, Number((event.target as HTMLInputElement).value))
}

function onPanInput(track: Track, event: Event): void {
  setTrackPan(track.id, Number((event.target as HTMLInputElement).value))
}

function onEqInput(track: Track, band: (typeof EQ_BANDS)[number]['key'], event: Event): void {
  setTrackEq(track.id, band, Number((event.target as HTMLInputElement).value))
}

function onSendInput(track: Track, event: Event): void {
  setTrackReverbSend(track.id, Number((event.target as HTMLInputElement).value))
}

function onMasterInput(event: Event): void {
  setMasterVolume(Number((event.target as HTMLInputElement).value))
}

function onReverbReturnInput(event: Event): void {
  setReverbWet(Number((event.target as HTMLInputElement).value))
}

function onLimiterInput(event: Event): void {
  setLimiterThreshold(Number((event.target as HTMLInputElement).value))
}

const panText = (pan: number): string => {
  if (Math.abs(pan) < 0.02) return 'C'
  return pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`
}
</script>

<template>
  <div class="mixer">
    <div class="strips">
      <div
        v-for="track in tracks"
        :key="track.id"
        class="strip"
        :class="{ selected: state.selectedTrackId === track.id }"
        @click="selectTrack(track.id)"
      >
        <div class="head">
          <span class="dot" :style="{ background: track.color }" />
          <span class="name" :title="track.name">{{ track.name }}</span>
        </div>

        <!-- 电平表 + 推子 -->
        <div class="fader-area">
          <div class="meter" title="实时电平">
            <div class="meter-fill" :style="{ height: levelPercent(state.levels[track.id] ?? 0) + '%' }" />
          </div>
          <div class="fader" title="音量推子 0~1">
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="track.volume"
              @input="onVolumeInput(track, $event)"
            />
          </div>
          <div class="db">{{ gainToDbText(track.volume) }}</div>
        </div>

        <!-- 声像 -->
        <div class="ctrl">
          <span class="label">声像</span>
          <input
            type="range"
            min="-1"
            max="1"
            step="0.02"
            :value="track.pan"
            @input="onPanInput(track, $event)"
          />
          <span class="val">{{ panText(track.pan) }}</span>
        </div>

        <!-- 三段均衡 -->
        <div class="eq">
          <div v-for="band in EQ_BANDS" :key="band.key" class="eq-row">
            <span class="label">{{ band.label }}</span>
            <input
              type="range"
              :min="EQ_MIN"
              :max="EQ_MAX"
              step="1"
              :value="track[band.key]"
              :title="`${band.label}频增益 ${EQ_MIN}~${EQ_MAX} dB`"
              @input="onEqInput(track, band.key, $event)"
            />
            <span class="val">{{ track[band.key] > 0 ? '+' : '' }}{{ track[band.key] }}</span>
          </div>
        </div>

        <!-- 混响发送 -->
        <div class="ctrl">
          <span class="label">混响</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="track.reverbSend"
            title="送入共享混响总线的量"
            @input="onSendInput(track, $event)"
          />
          <span class="val">{{ Math.round(track.reverbSend * 100) }}</span>
        </div>

        <div class="buttons">
          <button
            class="toggle"
            :class="{ on: track.mute }"
            title="静音"
            @click.stop="toggleMute(track.id)"
          >
            M
          </button>
          <button
            class="toggle solo"
            :class="{ on: track.solo }"
            title="独奏"
            @click.stop="toggleSolo(track.id)"
          >
            S
          </button>
          <button class="reset" title="复位本轨混音参数" @click.stop="resetTrackMix(track.id)">复位</button>
        </div>
      </div>

      <div v-if="tracks.length === 0" class="empty">还没有轨道，请在左侧面板新增</div>
    </div>

    <!-- 总线通道 -->
    <div class="master-strip">
      <div class="head">
        <span class="dot master-dot" />
        <span class="name">总线 Master</span>
      </div>

      <div class="fader-area">
        <div class="meter" title="总线输出电平">
          <div class="meter-fill" :style="{ height: levelPercent(state.masterLevel) + '%' }" />
        </div>
        <div class="fader" title="总音量">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="state.project.masterVolume"
            @input="onMasterInput"
          />
        </div>
        <div class="db">{{ gainToDbText(state.project.masterVolume) }}</div>
      </div>

      <div class="led-row">
        <span class="led" :class="{ on: state.limiting }" />
        <span class="led-text">{{ state.limiting ? '限幅中' : '未触发' }}</span>
      </div>

      <div class="ctrl">
        <span class="label">混响返回</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="state.project.reverbWet"
          title="共享混响总线送回主输出的电平"
          @input="onReverbReturnInput"
        />
        <span class="val">{{ Math.round(state.project.reverbWet * 100) }}</span>
      </div>

      <div class="ctrl">
        <span class="label">限幅阈值</span>
        <input
          type="range"
          :min="LIMITER_MIN"
          :max="LIMITER_MAX"
          step="1"
          :value="state.project.masterLimiter"
          title="超过该电平时自动压制，防止削波"
          @input="onLimiterInput"
        />
        <span class="val">{{ state.project.masterLimiter }}</span>
      </div>

      <p class="tip">链路：乐器 → 均衡 → 声像 → 推子 → 干声/混响总线 → 总音量 → 限幅 → 输出</p>
    </div>
  </div>
</template>

<style scoped>
.mixer {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.strips {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 1px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px;
  background: var(--bg);
}

.empty {
  color: var(--text-dim);
  padding: 20px;
}

.strip,
.master-strip {
  flex: 0 0 128px;
  width: 128px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 6px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  cursor: pointer;
  overflow-y: auto;
}

.strip.selected {
  border-color: var(--accent);
  background: #232833;
}

.master-strip {
  flex: 0 0 156px;
  width: 156px;
  margin: 8px 8px 8px 0;
  cursor: default;
  border-color: #444b5c;
}

.head {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}

.master-dot {
  background: var(--accent-2);
}

.name {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 推子区：电平表 + 竖向推子 */
.fader-area {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 6px;
  height: 118px;
}

.meter {
  position: relative;
  width: 8px;
  height: 110px;
  background: #14151a;
  border: 1px solid var(--line);
  border-radius: 3px;
  overflow: hidden;
  flex: 0 0 auto;
}

.meter-fill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* 渐变固定锚定在容器底部，颜色随电平高低自然过渡 */
  background-image: linear-gradient(to top, #63c78d 0%, #e8c34f 72%, #ff4d6d 100%);
  background-size: 100% 110px;
  background-position: bottom;
  background-repeat: no-repeat;
  transition: height 0.06s linear;
}

/* 竖向推子：横向 range 旋转 -90° 实现，兼容性比 vertical-lr 更稳 */
.fader {
  width: 24px;
  height: 110px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.fader input[type='range'] {
  width: 110px;
  transform: rotate(-90deg);
}

.db {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  text-align: center;
  min-width: 34px;
}

.ctrl {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ctrl input[type='range'] {
  flex: 1;
  min-width: 0;
}

.label {
  color: var(--text-dim);
  font-size: 11px;
  flex: 0 0 auto;
  white-space: nowrap;
}

.val {
  width: 30px;
  text-align: right;
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.eq {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.eq-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.eq-row .label {
  width: 14px;
}

.eq-row input[type='range'] {
  flex: 1;
  min-width: 0;
}

.buttons {
  display: flex;
  gap: 4px;
}

.toggle {
  flex: 1;
  padding: 2px 0;
  text-align: center;
  font-weight: 600;
  font-size: 12px;
}

.toggle.on {
  background: var(--accent-2);
  border-color: var(--accent-2);
  color: #fff;
}

.toggle.solo.on {
  background: var(--ok);
  border-color: var(--ok);
  color: #10231a;
}

.reset {
  padding: 2px 6px;
  font-size: 11px;
}

.led-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.led {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #3a3e4a;
  border: 1px solid var(--line);
  flex: 0 0 auto;
}

.led.on {
  background: var(--accent-2);
  border-color: var(--accent-2);
  box-shadow: 0 0 6px var(--accent-2);
}

.led-text {
  font-size: 11px;
  color: var(--text-dim);
}

.tip {
  margin: 0;
  font-size: 10px;
  line-height: 1.6;
  color: var(--text-dim);
}
</style>
