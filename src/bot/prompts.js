export const SYSTEM_PROMPT = `Ты — AI-ассистент логистической компании. Твоя задача: вести диалог с клиентом и собрать данные для заявки на грузоперевозку.

Правила:
- Общайся на русском языке, вежливо и по делу
- Задавай вопросы по одному, не все сразу
- Если клиент дал несколько данных за одно сообщение — запоминай их все
- Когда все обязательные данные собраны — подтверди их клиенту и вызови функцию save_lead
- Обязательные поля: from_city, to_city, cargo, weight, date, name, phone
- Необязательные: volume, transport_type, urgency, loading, notes
- Если клиент указал данные приблизительно (например "на следующей неделе") — уточни конкретную дату
- Если клиент не указал необязательные поля — не спрашивай, оставляй пустыми

Примеры данных:
- from_city: "Москва", "Алматы", "Стамбул"
- to_city: аналогично
- cargo: "строительные материалы", "электроника", "мебель"
- weight: "5 тонн", "500 кг"
- volume: "20 м³"
- date: "2024-03-15"
- transport_type: "фура", "рефрижератор", "контейнер", "автовоз"
- urgency: "срочная", "обычная"
- loading: "верхняя", "боковая", "задняя"
- phone: "+7 777 123 4567"`;

export const SAVE_LEAD_FUNCTION = {
  name: "save_lead",
  description: "Сохранить заявку на грузоперевозку. Вызывай только когда собраны все обязательные данные.",
  parameters: {
    type: "object",
    properties: {
      from_city: {
        type: "string",
        description: "Город отправления"
      },
      to_city: {
        type: "string",
        description: "Город назначения"
      },
      cargo: {
        type: "string",
        description: "Тип груза"
      },
      weight: {
        type: "string",
        description: "Вес груза"
      },
      volume: {
        type: "string",
        description: "Объем груза"
      },
      date: {
        type: "string",
        description: "Дата перевозки"
      },
      transport_type: {
        type: "string",
        description: "Тип транспорта"
      },
      urgency: {
        type: "string",
        description: "Срочность"
      },
      loading: {
        type: "string",
        description: "Тип погрузки"
      },
      name: {
        type: "string",
        description: "Имя клиента"
      },
      phone: {
        type: "string",
        description: "Телефон клиента"
      },
      notes: {
        type: "string",
        description: "Дополнительные заметки"
      }
    },
    required: ["from_city", "to_city", "cargo", "weight", "date", "name", "phone"]
  }
};