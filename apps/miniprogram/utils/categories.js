/**
 * 消费分类配置
 */
const CATEGORIES = [
  { id: 'food', name: '餐饮', icon: '🍜', tagClass: 'tag-food' },
  { id: 'transport', name: '交通', icon: '🚗', tagClass: 'tag-transport' },
  { id: 'hotel', name: '住宿', icon: '🏨', tagClass: 'tag-hotel' },
  { id: 'ticket', name: '门票', icon: '🎫', tagClass: 'tag-ticket' },
  { id: 'shopping', name: '购物', icon: '🛍️', tagClass: 'tag-shopping' },
  { id: 'other', name: '其他', icon: '📦', tagClass: 'tag-other' }
];

function getCategoryById(id) {
  return CATEGORIES.find(c => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}

module.exports = {
  CATEGORIES,
  getCategoryById
};
