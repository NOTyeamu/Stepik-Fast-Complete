using System;

class Program
{
    static void Main()
    {
        string input = Console.ReadLine();
        bool found = false;

        foreach (char c in input)
        {
            if (char.IsUpper(c))
            {
                Console.WriteLine(c);
                found = true;
                break; // Завершаем цикл после первой найденной заглавной буквы
            }
        }

        if (!found)
        {
            Console.WriteLine("Нет заглавных");
        }
    }
}