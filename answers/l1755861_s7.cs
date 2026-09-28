using System;

class Program
{
    static void Main()
    {
        string color = Console.ReadLine();
        
        if (color == "красный")
        {
            Console.WriteLine("Стой");
        }
        else if (color == "жёлтый")
        {
            Console.WriteLine("Жди");
        }
        else if (color == "зелёный")
        {
            Console.WriteLine("Иди");
        }
        else
        {
            Console.WriteLine("Неизвестный цвет");
        }
    }
}