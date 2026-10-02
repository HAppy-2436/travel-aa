/**
 * OCR识别云函数
 * 支持：微信/支付宝账单截图、消费小票、收据
 * 流程：图片上传云存储 → OCR识别 → 规则解析 → 返回结构化数据 → 删除图片
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ============ 腾讯云OCR配置 ============
// 在这里填入你的腾讯云SecretId和SecretKey
// 获取方式：https://console.cloud.tencent.com/cam/capi
const SECRET_ID = process.env.TENCENT_SECRET_ID || '';
const SECRET_KEY = process.env.TENCENT_SECRET_KEY || '';

/**
 * 调用腾讯云OCR API
 */
async function callTencentOCR(imageUrl) {
  const tencentcloud = require("tencentcloud-sdk-nodejs-ocr");
  const OcrClient = tencentcloud.ocr.v20181119.Client;

  const client = new OcrClient({
    credential: {
      secretId: SECRET_ID,
      secretKey: SECRET_KEY,
    },
    region: "ap-guangzhou",
    profile: {
      httpProfile: {
        endpoint: "ocr.tencentcloudapi.com",
      },
    },
  });

  // 使用通用印刷体识别
  const params = {
    ImageUrl: imageUrl,
    // 或者使用 ImageBase64: base64String
  };

  const result = await client.GeneralBasicOCR(params);
  return result.TextDetections || [];
}

/**
 * 调用微信云开发OCR（备用方案）
 */
async function callWechatOCR(fileID) {
  try {
    const result = await cloud.openapi.ocr.printedText({
      imgUrl: fileID,
      type: 'photo'
    });
    return result.items || [];
  } catch (e) {
    console.log('微信OCR不可用', e);
    return null;
  }
}

// ============ 文本解析规则 ============

/**
 * 从OCR文本中提取金额
 * 支持格式：¥123.45, 123.45元, 金额：123, 合计 123.00 等
 */
function extractAmount(texts) {
  const fullText = texts.join('\n');

  // 金额匹配规则（按优先级）
  const patterns = [
    // 明确标注的金额
    /(?:实付金额|实付|应付金额|支付金额|付款金额|消费金额|合计金额|总计金额|总金额)[\s:：]*[¥￥]?([0-9]+\.?[0-9]{0,2})/i,
    // 合计/总计
    /(?:合计|总计|总额|共计|小计|金额合)[\s:：]*[¥￥]?([0-9]+\.?[0-9]{0,2})/i,
    // 人民币符号
    /[¥￥]([0-9]+\.[0-9]{2})/,
    // XX.XX元
    /([0-9]+\.[0-9]{2})\s*元/,
    // 金额: XX
    /(?:金额|消费|付款|支付|转账)[\s:：]*([0-9]+\.?[0-9]{0,2})/i,
    // 最后兜底：独立的两位小数金额
    /(?:^|\s)([0-9]{1,7}\.[0-9]{2})(?:\s|$)/m
  ];

  for (const pattern of patterns) {
    const match = fullText.match(pattern);
    if (match) {
      const amount = parseFloat(match[1]);
      if (amount > 0 && amount < 1000000) {
        return Math.round(amount * 100) / 100;
      }
    }
  }

  return null;
}

/**
 * 从OCR文本中提取商户名
 */
function extractMerchant(texts) {
  const fullText = texts.join('\n');

  const patterns = [
    /(?:商户名称|商户|收款方|收款人|商家|店铺|门店|商家名称|付款给|收款方名称)[\s:：]*([^\n]{2,30})/i,
    /(?:向|给)([^\n]{2,20})(?:付款|支付|转账)/,
    // 支付宝格式
    /付款给\s*([^\n]{2,20})/,
    // 微信格式
    /收款方[\s:：]*([^\n]{2,20})/
  ];

  for (const pattern of patterns) {
    const match = fullText.match(pattern);
    if (match) {
      let name = match[1].trim()
        .replace(/[\s·・]+$/, '')
        .replace(/[（(].*[)）]/, '')
        .substring(0, 25);
      if (name.length >= 2) return name;
    }
  }

  return '';
}

/**
 * 从OCR文本中提取时间
 */
function extractTime(texts) {
  const fullText = texts.join('\n');

  const patterns = [
    // 2024-10-01 14:30:00
    /(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/,
    // 2024年10月1日 14:30
    /(\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2})/,
    // 10-01 14:30
    /(\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})/,
    // 14:30:30
    /(\d{2}:\d{2}:\d{2})/
  ];

  for (const pattern of patterns) {
    const match = fullText.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return '';
}

/**
 * 识别图片类型（支付宝/微信/小票）
 */
function detectImageType(texts) {
  const fullText = texts.join(' ');

  if (fullText.includes('支付宝') || fullText.includes('ALIPAY') || fullText.includes('蚂蚁')) {
    return 'alipay';
  }
  if (fullText.includes('微信支付') || fullText.includes('WeChat') || fullText.includes('财付通')) {
    return 'wechat';
  }
  if (fullText.includes('小票') || fullText.includes('收据') || fullText.includes('RECEIPT')) {
    return 'receipt';
  }
  return 'unknown';
}

/**
 * 消费分类智能判断
 */
function guessCategory(texts) {
  const fullText = texts.join(' ').toLowerCase();

  const categoryKeywords = {
    food: ['餐厅', '饭店', '美食', '小吃', '咖啡', '奶茶', '火锅', '烧烤', '外卖', '美团', '饿了么', '肯德基', '麦当劳', '星巴克', '餐', '食'],
    transport: ['打车', '滴滴', '出租', '地铁', '公交', '高铁', '火车', '飞机', '机票', '航空', '12306', '出行', '加油', '停车'],
    hotel: ['酒店', '宾馆', '民宿', '住宿', '旅馆', '携程', '如家', '汉庭', 'airbnb', '房间'],
    ticket: ['门票', '景区', '公园', '博物馆', '展览', '演出', '电影', '票务', '游玩'],
    shopping: ['超市', '商场', '购物', '淘宝', '京东', '拼多多', '商店', '便利店', '服装', '数码'],
  };

  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some(kw => fullText.includes(kw))) {
      return category;
    }
  }

  return 'other';
}

// ============ 主函数 ============
exports.main = async (event, context) => {
  const { fileID, imageUrl } = event;
  let finalImageUrl = imageUrl;
  let texts = [];
  let ocrSource = '';

  try {
    // 1. 获取图片URL
    if (!finalImageUrl && fileID) {
      const { fileList } = await cloud.getTempFileURL({
        fileList: [fileID]
      });
      if (fileList && fileList[0] && fileList[0].tempFileURL) {
        finalImageUrl = fileList[0].tempFileURL;
      }
    }

    if (!finalImageUrl) {
      return { success: false, error: '请提供图片' };
    }

    // 2. 调用OCR识别
    // 优先使用腾讯云OCR
    if (SECRET_ID && SECRET_KEY) {
      try {
        const detections = await callTencentOCR(finalImageUrl);
        texts = detections.map(d => d.DetectedText);
        ocrSource = 'tencent';
      } catch (e) {
        console.log('腾讯云OCR失败，尝试微信OCR', e);
      }
    }

    // 备用：微信OCR
    if (texts.length === 0 && fileID) {
      const wechatItems = await callWechatOCR(fileID);
      if (wechatItems) {
        texts = wechatItems.map(i => i.text);
        ocrSource = 'wechat';
      }
    }

    // 3. 如果都失败，返回手动输入模式
    if (texts.length === 0) {
      return {
        success: true,
        needManual: true,
        amount: null,
        merchant: '',
        time: '',
        category: 'other',
        imageType: 'unknown',
        confidence: 0,
        rawText: '',
        ocrSource: 'none',
        message: '识别服务暂不可用，请手动输入'
      };
    }

    // 4. 规则解析
    const amount = extractAmount(texts);
    const merchant = extractMerchant(texts);
    const time = extractTime(texts);
    const imageType = detectImageType(texts);
    const category = guessCategory(texts);

    // 5. 计算置信度
    let confidence = 60;
    if (amount !== null) confidence += 20;
    if (merchant) confidence += 10;
    if (time) confidence += 10;
    if (imageType !== 'unknown') confidence += 5;
    confidence = Math.min(confidence, 98);

    // 6. 删除临时图片（隐私保护）
    if (fileID && fileID.includes('/ocr/')) {
      try {
        await cloud.deleteFile({ fileList: [fileID] });
        console.log('临时图片已删除');
      } catch (e) {
        console.log('删除临时图片失败', e);
      }
    }

    // 7. 返回结果
    return {
      success: true,
      needManual: amount === null,
      amount,
      merchant,
      time,
      category,
      imageType,
      confidence,
      rawText: texts.join('\n').substring(0, 500),
      ocrSource,
      message: amount ? '识别成功' : '未能识别金额，请手动输入'
    };

  } catch (err) {
    console.error('OCR识别失败', err);

    // 清理临时图片
    if (fileID && fileID.includes('/ocr/')) {
      try {
        await cloud.deleteFile({ fileList: [fileID] });
      } catch (e) {}
    }

    return {
      success: false,
      error: err.message || '识别失败',
      needManual: true,
      amount: null,
      merchant: '',
      time: '',
      category: 'other',
      confidence: 0
    };
  }
};
